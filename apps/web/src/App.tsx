import { useEffect, useState } from "react";
import { Megaphone, MonitorPlay } from "lucide-react";
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
import {
  STATIONS,
  stationName,
  workspaceStations,
} from "./data/demo-clinic.js";
import { configStore } from "./data/config-store.js";
import { eventBus, staffNotifier } from "./data/bootstrap.js";
import { useAuth } from "./data/useAuth.js";
import { useClinic } from "./data/useClinic.js";
import { useConnectionMonitor } from "./components/ui/ConnectionStatus.js";
import { SignIn } from "./features/auth/SignIn.js";
import { AdminPortal } from "./features/admin/AdminPortal.js";

export function App() {
  const auth = useAuth();
  const [active, setActive] = useState<NavKey>("reception");
  const [stationId, setStationId] = useState<StationId>(STATIONS.consultation);
  const user = auth.currentUser();
  const clinic = useClinic();
  const connection = useConnectionMonitor({ signal: clinic.heartbeat });

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

  /**
   * Staff notifications follow the station the user is working, and are torn
   * down when they move. Notifying a doctor about a queue they left is noise,
   * and noise is how notifications get switched off.
   */
  useEffect(() => {
    if (active !== "clinical") return;
    return eventBus.subscribe(staffNotifier.staffSubscriber(stationId));
  }, [active, stationId]);

  if (!user) {
    return (
      <SignIn auth={auth} onSignedIn={() => setActive("reception")} />
    );
  }

  return (
    <AnnouncerProvider>
      <AppShell
        user={user}
        onSignOut={() => auth.signOut()}
        connection={connection}
        active={active}
        onNavigate={setActive}
        primaryAction={
          <div className="flex items-center gap-2">
            {/* The board and tracker are separate applications, so these are
                real links into another build rather than route changes. */}
            <Button
              variant="secondary"
              icon={<MonitorPlay className="size-4" />}
              onClick={() =>
                window.open(
                  `/display.html?board=${configStore.config.displayBoards[0]!.id}`,
                  "_blank",
                  "noopener",
                )
              }
            >
              Display Board
            </Button>
            {active === "reception" && (
              <Button icon={<Megaphone className="size-4" />}>Call Next</Button>
            )}
          </div>
        }
      >
        {active === "reception" && (
          <ReceptionDashboard onOpenVisit={() => setActive("clinical")} />
        )}

        {active === "clinical" && (
          <div className="space-y-6">
            <StationSwitcher value={stationId} onChange={setStationId} />
            {/* Remounting per station keeps each workspace's timers and
                shortcuts scoped to the station actually on screen. */}
            <StationWorkspace key={stationId} stationId={stationId} />
          </div>
        )}

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

        {active === "activity" && <ActivityExplorer />}

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
  return (
    <div
      role="tablist"
      aria-label="Station"
      className="flex flex-wrap gap-1 rounded-md border border-outline-variant bg-surface-container-low p-1"
    >
      {workspaceStations().map((id) => {
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
                ? "bg-surface-container-lowest text-primary shadow-card"
                : "text-on-surface-variant hover:bg-surface-container-high",
            )}
          >
            <span aria-hidden="true">{profileFor(id).icon}</span>
            {stationName(id)}
          </button>

        );
      })}
    </div>
  );
}
