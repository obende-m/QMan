import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRound, Lock, LockOpen, Power, UserPlus } from "lucide-react";
import type { RoleConfig } from "@qman/domain";
import { Button } from "../../components/ui/Button.js";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { StatusChip } from "../../components/ui/StatusChip.js";
import { ApiError } from "../../api/client.js";
import type { AccountSummary, AdministrationApi, BranchRow } from "../../data/administration-api.js";

function failure(error: unknown): string {
  return error instanceof ApiError ? error.message : "That could not be done. Try again.";
}

/**
 * A password shown exactly once.
 *
 * It is in the response that created it and nowhere else — not stored, not
 * logged, not retrievable — so the screen says so plainly, and the holder must
 * replace it at their first sign-in.
 */
function OneTimePassword({ username, password, onDone }: { username: string; password: string; onDone: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-primary/30 bg-primary/5 p-4">
      <p className="text-body-md text-on-surface">
        Temporary password for <strong>{username}</strong>. Give it to them in person; it will not be shown again,
        and they must change it when they first sign in.
      </p>
      <p className="mt-3 select-all rounded-md bg-surface-container-lowest px-3 py-2 font-mono text-title-md tracking-wide text-on-surface">
        {password}
      </p>
      <Button size="sm" variant="secondary" className="mt-3" onClick={onDone}>
        I have given it to them
      </Button>
    </div>
  );
}

export function UsersSection({
  api,
  roles,
  currentUserId,
}: {
  api: AdministrationApi;
  roles: readonly RoleConfig[];
  currentUserId: string;
}) {
  const [users, setUsers] = useState<AccountSummary[] | null>(null);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ username: string; password: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [{ users: list }, { branches: branchList }] = await Promise.all([api.users(), api.branches()]);
      setUsers(list);
      setBranches(branchList);
    } catch (err) {
      setError(failure(err));
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await reload();
    } catch (err) {
      setError(failure(err));
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Staff accounts"
          subtitle="Who can sign in to this organization, with which role, and where."
          action={
            <Button size="sm" icon={<UserPlus className="size-4" />} onClick={() => setAdding((v) => !v)}>
              Add account
            </Button>
          }
        />
        <div className="space-y-4 px-gutter pb-gutter">
          {error && (
            <p role="alert" className="rounded-md border border-error/40 bg-error-container/40 p-3 text-body-sm text-on-surface">
              {error}
            </p>
          )}
          {secret && <OneTimePassword {...secret} onDone={() => setSecret(null)} />}
          {adding && (
            <NewAccountForm
              roles={roles}
              branches={branches}
              onCancel={() => setAdding(false)}
              onCreate={async (input) => {
                setError(null);
                try {
                  const created = await api.createUser(input);
                  setSecret({ username: input.username, password: created.temporaryPassword });
                  setAdding(false);
                  await reload();
                } catch (err) {
                  setError(failure(err));
                }
              }}
            />
          )}

          {users === null ? (
            <p role="status" className="text-body-sm text-on-surface-variant">Loading accounts…</p>
          ) : users.length === 0 ? (
            <p className="text-body-sm text-on-surface-variant">No accounts yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left">
                <thead>
                  <tr className="border-b border-outline-variant/70">
                    {["Name", "Role", "Branches", "Status", "Last sign-in", ""].map((heading) => (
                      <th key={heading} scope="col" className="py-2 pr-3 font-mono text-label-caps uppercase text-on-surface-variant">
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id} className="border-b border-outline-variant/50 last:border-0">
                      <td className="py-3 pr-3">
                        <p className="text-body-md font-semibold text-on-surface">{user.displayName}</p>
                        <p className="font-mono text-label-caps text-on-surface-variant">{user.username}</p>
                      </td>
                      <td className="py-3 pr-3">
                        <select
                          aria-label={`Role for ${user.username}`}
                          className="field h-9"
                          value={user.roleId}
                          onChange={(e) => void run(() => api.updateUser(user.id, { roleId: e.target.value }))}
                        >
                          {roles.map((role) => (
                            <option key={role.id} value={role.id}>
                              {role.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-3 pr-3 text-body-sm text-on-surface-variant">
                        {user.branchIds.length === 0
                          ? "All branches"
                          : user.branchIds.map((id) => branches.find((b) => b.id === id)?.name ?? "Unknown").join(", ")}
                      </td>
                      <td className="py-3 pr-3">
                        <div className="flex flex-wrap gap-1">
                          <StatusChip tone={user.enabled ? "completed" : "neutral"} label={user.enabled ? "Active" : "Disabled"} withDot />
                          {user.lockedUntil && <StatusChip tone="urgent" label="Locked" />}
                          {user.passwordChangeRequired && <StatusChip tone="waiting" label="Temporary password" />}
                        </div>
                      </td>
                      <td className="py-3 pr-3 text-body-sm text-on-surface-variant">
                        {user.lastSignInAt ? new Date(user.lastSignInAt).toLocaleString() : "Never"}
                      </td>
                      <td className="py-3">
                        <div className="flex justify-end gap-1">
                          {user.lockedUntil && (
                            <Button size="sm" variant="ghost" icon={<LockOpen className="size-4" />} onClick={() => void run(() => api.unlock(user.id))}>
                              Unlock
                            </Button>
                          )}
                          {user.providerId === "local" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<KeyRound className="size-4" />}
                              onClick={() =>
                                void run(async () => {
                                  const { temporaryPassword } = await api.resetPassword(user.id);
                                  setSecret({ username: user.username, password: temporaryPassword });
                                })
                              }
                            >
                              Reset password
                            </Button>
                          )}
                          {user.id !== currentUserId && (
                            <Button
                              size="sm"
                              variant={user.enabled ? "danger" : "secondary"}
                              icon={user.enabled ? <Lock className="size-4" /> : <Power className="size-4" />}
                              onClick={() => void run(() => api.updateUser(user.id, { enabled: !user.enabled }))}
                            >
                              {user.enabled ? "Disable" : "Enable"}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function NewAccountForm({
  roles,
  branches,
  onCreate,
  onCancel,
}: {
  roles: readonly RoleConfig[];
  branches: readonly BranchRow[];
  onCreate: (input: { username: string; displayName: string; roleId: string; branchIds: string[] }) => Promise<void>;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    await onCreate({ username: username.trim(), displayName: displayName.trim(), roleId, branchIds });
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-xl border border-outline-variant/70 bg-surface-container-lowest/60 p-4 sm:grid-cols-2">
      <label className="block">
        <span className="field-label">Full name</span>
        <input className="field" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={120} />
      </label>
      <label className="block">
        <span className="field-label">Username</span>
        <input
          className="field font-mono"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}"
          autoCapitalize="none"
        />
      </label>
      <label className="block">
        <span className="field-label">Role</span>
        <select className="field" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend className="field-label">Branches</legend>
        <p className="mb-2 text-body-sm text-on-surface-variant">None selected means every branch.</p>
        <div className="flex flex-wrap gap-2">
          {branches.map((branch) => (
            <label key={branch.id} className="flex items-center gap-2 text-body-sm text-on-surface">
              <input
                type="checkbox"
                checked={branchIds.includes(branch.id)}
                onChange={(e) =>
                  setBranchIds((ids) => (e.target.checked ? [...ids, branch.id] : ids.filter((id) => id !== branch.id)))
                }
              />
              {branch.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || roleId === ""}>
          {busy ? "Creating…" : "Create account"}
        </Button>
      </div>
    </form>
  );
}
