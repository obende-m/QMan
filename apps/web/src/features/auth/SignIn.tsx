import { useState } from "react";
import { BriefcaseMedical, LogIn, TriangleAlert } from "lucide-react";
import { Button } from "../../components/ui/Button.js";
import { cn } from "../../components/ui/cn.js";
import type { AuthStore } from "../../data/auth-store.js";
import { configStore } from "../../data/config-store.js";
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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const passwordProviders = auth.providers.filter((p) => p.kind === "password");
  const redirectProviders = auth.providers.filter((p) => p.kind === "redirect");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const provider = passwordProviders[0];
    if (!provider) {
      setError("No sign-in method is configured.");
      setBusy(false);
      return;
    }

    const result = await auth.signIn(
      provider.id,
      { username, password },
      { userAgent: navigator.userAgent },
    );

    setBusy(false);
    if (result.ok) {
      onSignedIn();
    } else {
      setError(result.message ?? "Could not sign you in.");
      setPassword("");
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-11 shrink-0 place-items-center rounded bg-primary-container text-on-primary"
          >
            <BriefcaseMedical className="size-6" />
          </span>
          <div>
            <p className="text-headline-lg font-bold leading-none text-primary">
              QMan
            </p>
            <p className="mt-1 text-body-sm text-on-surface-variant">
              {configStore.config.profile.name}
            </p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="rounded-lg border border-outline-variant bg-surface-container-lowest p-gutter shadow-card"
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
            <label className="block">
              <span className={labelClass}>Username</span>
              <input
                className={cn(inputClass, "mt-1.5")}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoFocus
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

          {redirectProviders.length > 0 && (
            <div className="mt-6 border-t border-outline-variant pt-4">
              <p className={labelClass}>Or continue with</p>
              <div className="mt-2 flex flex-col gap-2">
                {redirectProviders.map((provider) => (
                  <Button
                    key={provider.id}
                    variant="secondary"
                    onClick={() => {
                      window.location.href =
                        provider.authorizationUrl?.(window.location.href) ?? "#";
                    }}
                  >
                    {provider.name}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </form>

        <p className="mt-4 text-center text-body-sm text-on-surface-variant">
          Trouble signing in? Contact your administrator.
        </p>
      </div>
    </main>
  );
}
