import { useState } from "react";
import { BriefcaseMedical, LogIn, TriangleAlert } from "lucide-react";
import { Button } from "../../components/ui/Button.js";
import { cn } from "../../components/ui/cn.js";
import type { AuthStore } from "../../data/auth-store.js";
import { inputClass, labelClass } from "../../data/useConfig.js";

/**
 * Sign in.
 *
 * Lists whichever providers are registered. With only local accounts it is a
 * plain username and password; when a hospital adds SSO, the provider appears
 * as a button and nothing else on this screen changes.
 */
export interface SignInProps {
  auth: AuthStore;
  onSignedIn: () => void;
}

export function SignIn({ auth, onSignedIn }: SignInProps) {
  const [organization, setOrganization] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    // One sign-in path. The provider chooser existed because the browser held
    // several identity providers; the server exposes one endpoint and decides
    // for itself which provider an account belongs to.
    const result = await auth.signIn(organization, username, password);

    setBusy(false);
    if (result.ok) {
      onSignedIn();
    } else {
      setError(result.message);
      setPassword("");
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-11 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary-container to-primary text-on-primary shadow-[0_8px_20px_-8px_rgb(0_62_199/0.6)]"
          >
            <BriefcaseMedical className="size-6" />
          </span>
          <div>
            <p className="text-headline-lg font-bold leading-none text-primary">
              QMan
            </p>
            {/* The hospital's own name is not known until after sign-in: the
                configuration that holds it is not readable anonymously. */}
            <p className="mt-1 text-body-sm text-on-surface-variant">
              Patient Flow &amp; Operations
            </p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="glass glass-raised rounded-xl p-gutter"
        >
          <h1 className="text-title-md font-semibold text-on-surface">Sign in</h1>

          {error && (
            <p
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-md border border-error/40 bg-error-container/40 p-3 text-body-sm text-on-surface"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-error" />
              {error}
            </p>
          )}

          <div className="mt-4 space-y-4">
            {/*
              * The organization code, which selects the hospital.
              *
              * First, and remembered by the browser rather than the
              * application: staff sign in to the same hospital every day, and
              * asking them to retype it is the kind of friction that produces a
              * sticky note on the monitor.
              */}
            <label className="block">
              <span className={labelClass}>Organization code</span>
              <input
                className={cn(inputClass, "mt-1.5")}
                value={organization}
                onChange={(e) => setOrganization(e.target.value)}
                name="organization"
                autoComplete="organization"
                autoCapitalize="none"
                autoFocus
                required
              />
            </label>

            <label className="block">
              <span className={labelClass}>Username</span>
              <input
                className={cn(inputClass, "mt-1.5")}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                required
              />
            </label>

            <label className="block">
              <span className={labelClass}>Password</span>
              <input
                type="password"
                className={cn(inputClass, "mt-1.5")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
          </div>

          <Button
            type="submit"
            size="lg"
            className="mt-6 w-full"
            disabled={busy}
            icon={<LogIn className="size-5" />}
          >
            {busy ? "Signing in…" : "Sign in"}
          </Button>

        </form>

        <p className="mt-4 text-center text-body-sm text-on-surface-variant">
          Trouble signing in? Contact your administrator.
        </p>
      </div>
    </main>
  );
}
