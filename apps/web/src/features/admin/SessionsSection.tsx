import { ShieldOff } from "lucide-react";
import { Card, CardHeader } from "../../components/ui/Card.js";

/**
 * Session management.
 *
 * Disabled for Version 1, deliberately and visibly.
 *
 * The screen used to list active sessions and let an administrator end one. It
 * read them from the browser's own authentication store, which held every
 * session because it created every session. With authentication on the server
 * that is no longer true, and the capability to replace it does not exist yet.
 *
 * TODO(backend): session administration needs two endpoints that are not built.
 *   - GET    /api/v1/sessions       currently answers with an empty list
 *   - DELETE /api/v1/sessions/:id   does not exist
 *   The persistence is already there — `PostgresSessionRepository` has
 *   `activeForHospital` and `endAllForUser` — but no routes expose them.
 *
 * Shown as unavailable rather than removed, because "sign that laptop out" is a
 * real thing administrators ask for, and a hospital deciding whether to deploy
 * should see that it is coming rather than assume it was left out by design.
 *
 * Fabricating a list, or leaving the browser-backed one in place, would both
 * have been worse than an honest gap: an administrator who ends a session and
 * watches it disappear will believe the machine was signed out.
 */
export function SessionsSection() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Active sessions"
          subtitle="Who is signed in, and on what."
        />
        <div className="px-gutter pb-gutter">
          <div className="flex items-start gap-3 rounded-md border border-dashed border-outline-variant p-4">
            <ShieldOff
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-on-surface-variant"
            />
            <div className="space-y-1">
              <p className="text-body-md text-on-surface">
                Session management is not available in this version.
              </p>
              <p className="text-body-sm text-on-surface-variant">
                Sessions are held by the server and cannot yet be listed or
                ended from here. To sign someone out immediately, disable their
                account in Users — every session they hold stops working on its
                next request.
              </p>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
