import { useEffect, useState } from "react";
import { MonitorPlay } from "lucide-react";
import type { StationId } from "@qman/domain";
import { AppShell, type NavKey } from "./components/layout/AppShell.js";
import { AnnouncerProvider } from "./components/ui/Announcer.js";
import { Button } from "./components/ui/Button.js";
import { cn } from "./components/ui/cn.js";
import { ReceptionDashboard } from "./features/reception/ReceptionDashboard.js";
import { StationWorkspace } from "./features/station/StationWorkspace.js";
import { ManagerDashboard } from "./features/manager/ManagerDashboard.js";
import { CommandCentre } from "./features/command/CommandCentre.js";
import { ActivityExplorer } from "./features/activity/ActivityExplorer.js";
import { profileFor } from "./features/station/station-profiles.js";
import { operationsStore } from "./data/operations-store.js";
import { stores } from "./data/runtime-stores.js";
import { useAuth } from "./data/useAuth.js";
import { useConfig } from "./data/useConfig.js";
import { useClinic } from "./data/useClinic.js";
import { setStaffDirectory } from "./data/clinic-projections.js";
import { useConnectionMonitor } from "./components/ui/ConnectionStatus.js";
import { SignIn } from "./features/auth/SignIn.js";
import { ChangePassword } from "./features/auth/ChangePassword.js";
import { AdminPortal } from "./features/admin/AdminPortal.js";

/** Shown while a gate is resolving. Deliberately plain: it is not a screen. */
function Loading({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="grid min-h-screen place-items-center text-body-md text-on-surface-variant"
    >
      {label}…
    </div>
  );
}

/**
 * Shown when the server cannot be reached.
 *
 * Names the request id when there is one, because that is what turns a phone
 * call into a search rather than a description.
 */
function Unavailable({
  message,
  detail,
  onRetry,
}: {
  message: string;
  detail: string | null;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="grid min-h-screen place-items-center p-6">
      <div className="max-w-md space-y-3 text-center">
        <p className="text-title-md text-on-surface">{message}</p>
        {detail !== null && (
          <p className="font-mono text-body-sm text-on-surface-variant">
            Reference {detail}
          </p>
        )}
        <Button onClick={onRetry}>Try again</Button>
      </div>
    </div>
  );
}

/** An intentional empty state, rather than a blank panel. */
export function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed border-outline-variant p-8 text-center">
      <p className="text-title-sm text-on-surface">{title}</p>
      <p className="mt-1 text-body-sm text-on-surface-variant">{body}</p>
    </div>
  );
}

export function App() {
  const auth = useAuth();
  const config = useConfig();
  const [active, setActive] = useState<NavKey>("reception");
  /**
   * Null until the configuration says which stations exist. There is no
   * default station to fall back on: which one a workspace opens is a property
   * of the hospital, and guessing produces a screen for a station that may not
   * be configured.
   */
  const [stationId, setStationId] = useState<StationId | null>(null);
  /** A journey opened from the search box, shown in the Activity Explorer. */
  const [journey, setJourney] = useState<string | undefined>(undefined);
  const user = auth.currentUser();
  const clinic = useClinic();
  const connection = useConnectionMonitor({ signal: clinic.heartbeat });

  /**
   * Operational telemetry reads the same stream the clinic does. Wired here
   * rather than in the composition root, which would import the operations
   * store and close a cycle back through the configuration it depends on.
   */
  useEffect(() => operationsStore.attachToStream(stores.stream), []);

  /** Resolves the session the cookie already carries, then the configuration. */
  useEffect(() => {
    void auth.load();
  }, [auth]);

  useEffect(() => {
    if (user === null) return;
    void config.load();
  }, [config, user]);

  /** Loads the branch's visits once both the user and the hospital are known. */
  useEffect(() => {
    if (user === null || config.status !== "ready") return;
    const branchId = user.branchId ?? config.config.branches[0]?.id;
    if (branchId === undefined) return;

    void (async () => {
      // Names before visits, so the first render of a workload panel already
      // has them. A failure leaves ids showing, which is honest.
      if (auth.can("reports.view")) {
        try {
          setStaffDirectory((await stores.administration.staff()).staff);
        } catch {
          /* ids it is */
        }
      }
      await clinic.load(branchId);

      /*
       * The audit trail is read once, then kept current by the stream.
       *
       * Without this the Activity Explorer would be empty on every page load
       * and fill only with what happened after it opened — a log that forgets
       * the morning is worse than no log, because it looks complete.
       */
      const { events } = await stores.activity.read({ branchId });
      operationsStore.ingestHistory(events);

      /*
       * Opened last, and only once a session and a branch exist. The stream
       * requires authentication, so starting it earlier spends a connection
       * attempt and a backoff step on a request that is going to be refused.
       */
      stores.stream.start();
    })();
  }, [auth, clinic, config, config.status, user]);

  /** Opens the first workspace station the hospital actually has. */
  useEffect(() => {
    if (config.status !== "ready" || stationId !== null) return;
    const first = config.workspaceStations()[0];
    if (first !== undefined) setStationId(first.id);
  }, [config, config.status, stationId]);

  /**
   * Activity extends the session. Tied to real interaction rather than a timer,
   * so a machine nobody is using does time out.
   */
  useEffect(() => {
    if (!user) return;
    const touch = () => auth.touchCurrent();
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    return () => {
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
    };
  }, [auth, user]);

  if (auth.status === "loading") {
    return <Loading label="Checking your session" />;
  }

  if (!user) {
    return <SignIn auth={auth} onSignedIn={() => setActive("reception")} />;
  }

  // The server refuses everything else until a temporary password is replaced.
  if (user.passwordChangeRequired === true) {
    return <ChangePassword auth={auth} required />;
  }

  /**
   * Nothing renders until the hospital is known.
   *
   * A queue drawn against an absent configuration looks like a quiet clinic
   * rather than a failed load, and nobody in a waiting room can tell the
   * difference.
   */
  if (config.status === "loading") {
    return <Loading label="Loading the hospital" />;
  }

  if (config.status === "failed") {
    return (
      <Unavailable
        message="QMan cannot reach the server."
        detail={config.error?.requestId ?? null}
        onRetry={() => void config.load()}
      />
    );
  }

  return (
    <AnnouncerProvider>
      <AppShell
        user={user}
        onSignOut={() => auth.signOut()}
        connection={connection}
        active={active}
        onNavigate={(key) => {
          if (key === "activity") setJourney(undefined);
          setActive(key);
        }}
        {...(auth.can("reports.view")
          ? {
              onSearch: (query: string) => {
                setJourney(query.toUpperCase());
                setActive("activity");
              },
            }
          : {})}
        primaryAction={
          <div className="flex items-center gap-2">
            {/* The board and tracker are separate applications, so these are
                real links into another build rather than route changes. */}
            <Button
              variant="secondary"
              icon={<MonitorPlay className="size-4" />}
              onClick={() =>
                window.open(
                  `/display.html?board=${config.config.displayBoards[0]?.id ?? ""}`,
                  "_blank",
                  "noopener",
                )
              }
            >
              Display Board
            </Button>
          </div>
        }
      >
        {active === "reception" && (
          <ReceptionDashboard onOpenVisit={() => setActive("clinical")} />
        )}

        {active === "clinical" &&
          (stationId === null ? (
            <EmptyPanel
              title="No stations configured"
              body="Add a station in the Administration portal before opening a workspace."
            />
          ) : (
            <div className="space-y-6">
              <StationSwitcher value={stationId} onChange={setStationId} />
              {/* Remounting per station keeps each workspace's timers and
                  shortcuts scoped to the station actually on screen. */}
              <StationWorkspace key={stationId} stationId={stationId} />
            </div>
          ))}

        {active === "manager" && (
          <ManagerDashboard
            onOpenStation={(id) => {
              setStationId(id as StationId);
              setActive("clinical");
            }}
          />
        )}

        {active === "command" && (
          <CommandCentre
            onOpenStation={(id) => {
              setStationId(id as StationId);
              setActive("clinical");
            }}
          />
        )}

        {active === "activity" && (
          <ActivityExplorer
            key={journey ?? "all"}
            {...(journey !== undefined ? { initialCorrelationId: journey } : {})}
          />
        )}

        {active === "admin" && <AdminPortal />}
      </AppShell>
    </AnnouncerProvider>
  );
}

/**
 * Demonstrates the point of the Station Workspace: every one of these tabs
 * renders the same component. Only the vocabulary changes, and that comes from
 * configuration.
 *
 * In production this is a permissions concern — staff see the stations they are
 * assigned to — rather than a free switcher.
 */
function StationSwitcher({
  value,
  onChange,
}: {
  value: StationId;
  onChange: (stationId: StationId) => void;
}) {
  const config = useConfig();
  return (
    <div
      role="tablist"
      aria-label="Station"
      className="glass-subtle flex flex-wrap gap-1 rounded-xl p-1"
    >
      {config.workspaceStations().map((station) => {
        const id = station.id;
        const selected = id === value;
        return (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onChange(id)}
            className={cn(
              "flex items-center gap-2 rounded px-3 py-2 text-body-sm font-semibold transition-colors",
              selected
                ? "bg-surface-container-lowest/90 text-primary shadow-card"
                : "text-on-surface-variant hover:bg-surface-container-high",
            )}
          >
            <span aria-hidden="true">{profileFor(station.code).icon}</span>
            {station.name}
          </button>

        );
      })}
    </div>
  );
}
