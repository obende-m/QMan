/**
 * The Platform Portal.
 *
 * QMan's own administration: the organizations it hosts, their lifecycle, the
 * platform audit log, and how much of the platform is in use. It is not a
 * hospital's administration screen and shows nothing from inside one — no
 * staff, no patients, no configuration. Counts, and nothing below them.
 *
 * There is no tenancy in this file. It never holds a hospital id in order to
 * scope anything; ids appear only as the argument to an action the server then
 * authorizes for itself. Likewise `store.can` decides what to draw and decides
 * nothing else — a portal that drew every button would be a usability bug, not
 * a security one, because the guard runs again on every request.
 */
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { Activity, Building2, KeyRound, LogOut, Plus, ShieldAlert } from "lucide-react";
import { Button } from "../../components/ui/Button.js";
import { cn } from "../../components/ui/cn.js";
import type { IssuedCredentials, OrganizationSummary } from "../../data/platform-api.js";
import type { PlatformStore } from "../../data/platform-store.js";

type Section = "organizations" | "audit" | "health";

const inputClass =
  "w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-body-md text-on-surface";
const labelClass = "text-label-md text-on-surface-variant";
const alertClass =
  "rounded-lg bg-error-container p-3 text-body-sm text-on-error-container";
const emptyClass =
  "rounded-lg border border-dashed border-outline-variant p-8 text-center text-body-md text-on-surface-variant";

export function PlatformPortal({ store }: { store: PlatformStore }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [section, setSection] = useState<Section>("organizations");

  useEffect(() => {
    void store.load();
  }, [store]);

  if (state.status === "unknown") {
    return (
      <main
        role="status"
        className="grid min-h-screen place-items-center bg-background text-body-lg text-on-surface-variant"
      >
        Loading…
      </main>
    );
  }

  if (state.status === "signed_out") return <PlatformSignIn store={store} />;

  const sections = [
    { key: "organizations", label: "Organizations", Icon: Building2 },
    { key: "audit", label: "Audit log", Icon: ShieldAlert },
    { key: "health", label: "Health", Icon: Activity },
  ] as const;

  return (
    <div className="min-h-screen bg-background">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant px-6 py-4">
        <div>
          <h1 className="text-title-lg text-on-surface">QMan Platform</h1>
          <p className="text-body-sm text-on-surface-variant">
            Signed in as {state.user?.displayName}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<LogOut className="size-4" />}
          onClick={() => void store.signOut()}
        >
          Sign out
        </Button>
      </header>

      <nav
        aria-label="Platform sections"
        className="flex gap-1 border-b border-outline-variant px-4"
      >
        {sections.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            aria-current={section === key ? "page" : undefined}
            onClick={() => setSection(key)}
            className={cn(
              "flex items-center gap-2 px-4 py-3 text-label-lg",
              section === key
                ? "border-b-2 border-primary text-primary"
                : "text-on-surface-variant",
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            {label}
          </button>
        ))}
      </nav>

      <main className="p-6">
        {state.error !== null && (
          <p role="alert" className={cn(alertClass, "mb-4")}>
            {state.error}
          </p>
        )}

        {section === "organizations" && <OrganizationsSection store={store} />}
        {section === "audit" && <AuditSection store={store} />}
        {section === "health" && <HealthSection store={store} />}
      </main>
    </div>
  );
}

function PlatformSignIn({ store }: { store: PlatformStore }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await store.signIn(username, password);
    if (!result.ok) setError(result.message);
    setBusy(false);
  };

  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-outline-variant p-6"
      >
        <h1 className="text-headline-sm text-on-surface">QMan Platform</h1>
        {/*
          * Said plainly, because the two portals look alike and a member of a
          * hospital's staff who lands here would otherwise try their own
          * credentials and read the refusal as a broken account.
          */}
        <p className="mt-1 text-body-sm text-on-surface-variant">
          Platform administration. This is not a hospital sign-in.
        </p>

        {error !== null && (
          <p role="alert" className={cn(alertClass, "mt-4")}>
            {error}
          </p>
        )}

        <label className="mt-4 block">
          <span className={labelClass}>Username</span>
          <input
            className={cn(inputClass, "mt-1.5")}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoFocus
            required
          />
        </label>

        <label className="mt-4 block">
          <span className={labelClass}>Password</span>
          <input
            type="password"
            className={cn(inputClass, "mt-1.5")}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <Button type="submit" className="mt-6 w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}

/**
 * Credentials, shown once.
 *
 * Deliberately loud. This value cannot be retrieved again, and an administrator
 * who navigates away without copying it has to reset the account they have just
 * created — so the notice stays until it is explicitly dismissed rather than
 * fading on the next render.
 */
function IssuedCredentialsNotice({
  credentials,
  onDismiss,
}: {
  credentials: IssuedCredentials;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="mb-4 rounded-xl border-2 border-tertiary bg-tertiary-container p-4"
    >
      <p className="text-title-sm text-on-tertiary-container">
        Copy this password now — it is shown once and cannot be recovered.
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-md text-on-tertiary-container">
        <dt className="font-medium">Username</dt>
        <dd>
          <code>{credentials.username}</code>
        </dd>
        <dt className="font-medium">Password</dt>
        <dd>
          <code>{credentials.password}</code>
        </dd>
      </dl>
      <Button variant="secondary" size="sm" className="mt-3" onClick={onDismiss}>
        I have copied it
      </Button>
    </div>
  );
}

function OrganizationsSection({ store }: { store: PlatformStore }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <section aria-label="Organizations">
      {issued !== null && (
        <IssuedCredentialsNotice credentials={issued} onDismiss={() => setIssued(null)} />
      )}
      {error !== null && (
        <p role="alert" className={cn(alertClass, "mb-4")}>
          {error}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-title-md text-on-surface">
          Organizations ({state.organizations.length})
        </h2>
        {store.can("platform.organizations.create") && (
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            New organization
          </Button>
        )}
      </div>

      {creating && (
        <CreateOrganizationForm
          store={store}
          onCancel={() => setCreating(false)}
          onCreated={(administrator) => {
            setIssued(administrator);
            setCreating(false);
          }}
        />
      )}

      {state.organizations.length === 0 ? (
        <p className={emptyClass}>
          No organizations yet. Create the first one to get started.
        </p>
      ) : (
        <ul className="space-y-3">
          {state.organizations.map((organization) => (
            <OrganizationRow
              key={organization.id}
              organization={organization}
              store={store}
              onIssued={setIssued}
              onError={setError}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function OrganizationRow({
  organization,
  store,
  onIssued,
  onError,
}: {
  organization: OrganizationSummary;
  store: PlatformStore;
  onIssued: (credentials: IssuedCredentials) => void;
  onError: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [suspending, setSuspending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetUsername, setResetUsername] = useState("");

  return (
    <li className="rounded-xl border border-outline-variant p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-title-sm text-on-surface">{organization.name}</p>
          <p className="text-body-sm text-on-surface-variant">
            <code>{organization.code}</code> · {organization.branchCount} branches ·{" "}
            {organization.userCount} staff
          </p>
          {organization.status === "suspended" && (
            <p className="mt-1 text-body-sm text-error">
              Suspended: {organization.suspendedReason}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full px-3 py-1 text-label-sm",
              organization.status === "active"
                ? "bg-tertiary-container text-on-tertiary-container"
                : "bg-error-container text-on-error-container",
            )}
          >
            {organization.status}
          </span>

          {store.can("platform.organizations.suspend") &&
            (organization.status === "active" ? (
              <Button variant="secondary" size="sm" onClick={() => setSuspending(true)}>
                Suspend
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  const result = await store.reactivate(organization.id);
                  if (!result.ok) onError(result.message);
                }}
              >
                Reactivate
              </Button>
            ))}

          {store.can("platform.organizations.reset_admin") && (
            <Button
              variant="secondary"
              size="sm"
              icon={<KeyRound className="size-4" />}
              onClick={() => setResetting(true)}
            >
              Reset admin
            </Button>
          )}
        </div>
      </div>

      {suspending && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            const result = await store.suspend(organization.id, reason);
            if (!result.ok) onError(result.message);
            setSuspending(false);
            setReason("");
          }}
        >
          <label className="min-w-0 flex-1">
            <span className={labelClass}>Reason</span>
            <input
              className={cn(inputClass, "mt-1.5")}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
            />
          </label>
          <Button type="submit" size="sm">
            Confirm suspension
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setSuspending(false)}
          >
            Cancel
          </Button>
        </form>
      )}

      {resetting && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            const result = await store.resetAdministrator(organization.id, resetUsername);
            if (result.ok) onIssued(result.administrator);
            else onError(result.message);
            setResetting(false);
            setResetUsername("");
          }}
        >
          <label className="min-w-0 flex-1">
            <span className={labelClass}>Administrator username</span>
            <input
              className={cn(inputClass, "mt-1.5")}
              value={resetUsername}
              onChange={(event) => setResetUsername(event.target.value)}
              autoCapitalize="none"
              required
            />
          </label>
          <Button type="submit" size="sm">
            Reset password
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setResetting(false)}
          >
            Cancel
          </Button>
        </form>
      )}
    </li>
  );
}

function CreateOrganizationForm({
  store,
  onCancel,
  onCreated,
}: {
  store: PlatformStore;
  onCancel: () => void;
  onCreated: (administrator: IssuedCredentials) => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [branchName, setBranchName] = useState("Main Branch");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminDisplayName, setAdminDisplayName] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="mb-4 rounded-xl border border-outline-variant p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const result = await store.create({
          name,
          code,
          branchName,
          adminUsername,
          adminDisplayName,
          timezone,
        });
        setBusy(false);
        if (result.ok) onCreated(result.administrator);
        else setError(result.message);
      }}
    >
      <h3 className="text-title-sm text-on-surface">New organization</h3>

      {error !== null && (
        <p role="alert" className={cn(alertClass, "mt-3")}>
          {error}
        </p>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>Organization name</span>
          <input
            className={cn(inputClass, "mt-1.5")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>

        <label className="block">
          <span className={labelClass}>Organization code</span>
          <input
            className={cn(inputClass, "mt-1.5")}
            value={code}
            autoCapitalize="none"
            onChange={(event) => setCode(event.target.value)}
            required
          />
          <span className="mt-1 block text-body-sm text-on-surface-variant">
            What staff type at sign-in. Lowercase letters, digits and hyphens. It can be
            changed later.
          </span>
        </label>

        <label className="block">
          <span className={labelClass}>First branch</span>
          <input
            className={cn(inputClass, "mt-1.5")}
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            required
          />
        </label>

        <label className="block">
          <span className={labelClass}>Time zone</span>
          <input
            className={cn(inputClass, "mt-1.5")}
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            required
          />
        </label>

        <label className="block">
          <span className={labelClass}>Administrator username</span>
          <input
            className={cn(inputClass, "mt-1.5")}
            value={adminUsername}
            autoCapitalize="none"
            onChange={(event) => setAdminUsername(event.target.value)}
            required
          />
        </label>

        <label className="block">
          <span className={labelClass}>Administrator name</span>
          <input
            className={cn(inputClass, "mt-1.5")}
            value={adminDisplayName}
            onChange={(event) => setAdminDisplayName(event.target.value)}
          />
        </label>
      </div>

      <div className="mt-4 flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create organization"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AuditSection({ store }: { store: PlatformStore }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);

  return (
    <section aria-label="Audit log">
      <h2 className="mb-4 text-title-md text-on-surface">Platform audit log</h2>
      {state.events.length === 0 ? (
        <p className={emptyClass}>Nothing has happened yet.</p>
      ) : (
        <ol className="space-y-2">
          {state.events.map((event) => (
            <li key={event.id} className="rounded-lg border border-outline-variant p-3">
              <p className="text-body-md text-on-surface">{event.summary}</p>
              <p className="text-body-sm text-on-surface-variant">
                <code>{event.type}</code> · {new Date(event.at).toLocaleString()}
                {event.correlationId !== null && <> · request {event.correlationId}</>}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function HealthSection({ store }: { store: PlatformStore }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const health = state.health;

  if (health === null) {
    return (
      <p role="status" className="text-body-md text-on-surface-variant">
        Loading…
      </p>
    );
  }

  const tiles: ReadonlyArray<readonly [string, number]> = [
    ["Organizations", health.organizations.total],
    ["Active", health.organizations.active],
    ["Suspended", health.organizations.suspended],
    ["Branches", health.branches],
    ["Staff accounts", health.users],
    ["Platform administrators", health.platformAdministrators],
  ];

  return (
    <section aria-label="Health">
      <h2 className="mb-4 text-title-md text-on-surface">Platform health</h2>
      <dl className="grid gap-3 sm:grid-cols-3">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-outline-variant p-4">
            <dt className="text-label-md text-on-surface-variant">{label}</dt>
            <dd className="mt-1 text-headline-md text-on-surface">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
