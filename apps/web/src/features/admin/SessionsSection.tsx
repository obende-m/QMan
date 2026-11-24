import { useCallback, useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "../../components/ui/Button.js";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { ApiError } from "../../api/client.js";
import type { AdministrationApi, SessionRow } from "../../data/administration-api.js";

/**
 * Who is signed in, and on what.
 *
 * Read from the server, which holds every session, and ended there: ending a
 * session here stops it working on its very next request, which is what "sign
 * that laptop out" has to mean on a shared reception desk.
 */
export function SessionsSection({ api }: { api: AdministrationApi }) {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSessions((await api.sessions()).sessions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sessions could not be loaded.");
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const end = async (id: string) => {
    setError(null);
    try {
      await api.revokeSession(id);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That session could not be ended.");
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Active sessions" subtitle="Who is signed in, and on which machine." />
        <div className="px-gutter pb-gutter">
          {error && (
            <p role="alert" className="mb-3 rounded-md border border-error/40 bg-error-container/40 p-3 text-body-sm">
              {error}
            </p>
          )}
          {sessions === null ? (
            <p role="status" className="text-body-sm text-on-surface-variant">
              Loading sessions…
            </p>
          ) : sessions.length === 0 ? (
            <p className="text-body-sm text-on-surface-variant">Nobody is signed in.</p>
          ) : (
            <ul className="divide-y divide-outline-variant/50">
              {sessions.map((session) => (
                <li key={session.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-body-md font-semibold text-on-surface">
                      {session.displayName}
                      {session.current && (
                        <span className="ml-2 text-body-sm font-normal text-primary">(this session)</span>
                      )}
                    </p>
                    <p className="text-body-sm text-on-surface-variant">
                      {session.device || "Unknown device"} · signed in{" "}
                      {new Date(session.startedAt).toLocaleString()} · last active{" "}
                      {new Date(session.lastActiveAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                  {!session.current && (
                    <Button
                      size="sm"
                      variant="danger"
                      icon={<LogOut className="size-4" />}
                      onClick={() => void end(session.id)}
                    >
                      Sign out
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
