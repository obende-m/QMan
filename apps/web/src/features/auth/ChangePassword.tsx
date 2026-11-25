import { useState, type FormEvent } from "react";
import { KeyRound, TriangleAlert } from "lucide-react";
import { Button } from "../../components/ui/Button.js";
import type { AuthStore } from "../../data/auth-store.js";

/**
 * Replacing a temporary password.
 *
 * Shown instead of the application when the server says the password was set
 * by someone else — at provisioning or by an administrator's reset. The server
 * refuses every other action until this is done, so this is not a nag that can
 * be dismissed: it is the only screen that can do anything.
 */
export function ChangePassword({ auth, required }: { auth: AuthStore; required: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setProblems([]);
    if (next !== confirm) {
      setError("The two new passwords do not match.");
      return;
    }
    setBusy(true);
    const result = await auth.changePassword(current, next);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      setProblems(result.problems);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-10">
      <form onSubmit={submit} className="glass glass-raised w-full max-w-sm rounded-xl p-gutter">
        <div className="mb-4 flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary"
          >
            <KeyRound className="size-5" />
          </span>
          <h1 className="text-title-md font-semibold text-on-surface">Choose a new password</h1>
        </div>
        {required && (
          <p className="text-body-sm text-on-surface-variant">
            Your password was set by someone else. Replace it with one only you know before
            continuing.
          </p>
        )}

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-error/40 bg-error-container/40 p-3 text-body-sm text-on-surface"
          >
            <p className="flex items-start gap-2">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-error" />
              {error}
            </p>
            {problems.length > 0 && (
              <ul className="mt-2 list-disc pl-6">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="field-label">Current password</span>
            <input
              type="password"
              className="field"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
              autoFocus
            />
          </label>
          <label className="block">
            <span className="field-label">New password</span>
            <input
              type="password"
              className="field"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              minLength={10}
              required
            />
            <span className="mt-1 block text-body-sm text-on-surface-variant">
              At least 10 characters. A short phrase is easier to remember than a jumble.
            </span>
          </label>
          <label className="block">
            <span className="field-label">Repeat the new password</span>
            <input
              type="password"
              className="field"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
        </div>

        <Button type="submit" size="lg" className="mt-6 w-full" disabled={busy}>
          {busy ? "Saving…" : "Save new password"}
        </Button>
        <Button type="button" variant="ghost" className="mt-2 w-full" onClick={() => void auth.signOut()}>
          Sign out
        </Button>
      </form>
    </main>
  );
}
