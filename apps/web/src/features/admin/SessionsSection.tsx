import {
  DEFAULT_SESSION_POLICY,
  idleForMillis,
  sessionStatus,
  type Session,
} from "@qman/domain";
import { LogOut, MonitorSmartphone } from "lucide-react";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { Button } from "../../components/ui/Button.js";
import { StatusChip } from "../../components/ui/StatusChip.js";
import { cn } from "../../components/ui/cn.js";
import type { AuthStore } from "../../data/auth-store.js";
import { formatDuration, useNow } from "../../data/useClinic.js";

/**
 * Active sessions.
 *
 * The operational case that put this in Version 1: a reception workstation left
 * signed in overnight. An administrator can see it — device, when it signed in,
 * how long since anyone touched it — and end it from wherever they are, rather
 * than walking to the machine.
 *
 * Ended sessions stay listed for the rest of the day rather than vanishing.
 * "Who was signed in on that machine, and who ended it" is a question worth
 * being able to answer.
 */
export function SessionsSection({ auth }: { auth: AuthStore }) {
  const now = useNow(5000);
  const sessions = auth.sessions();
  const current = auth.currentSession();

  const active = sessions.filter(
    (s) => sessionStatus(s, now, DEFAULT_SESSION_POLICY) !== "ended",
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Active sessions"
          subtitle="Sign out a workstation without walking to it."
          action={
            <span className="rounded-full bg-surface-container-high px-2.5 py-1 font-mono text-label-caps uppercase text-on-surface-variant">
              {active.length} active
            </span>
          }
        />

        {active.length === 0 ? (
          <p className="px-gutter pb-gutter text-body-sm text-on-surface-variant">
            Nobody is signed in.
          </p>
        ) : (
          <ul className="divide-y divide-outline-variant border-t border-outline-variant">
            {active.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                now={now}
                isCurrent={session.id === current?.id}
                userName={auth.account(session.userId)?.displayName ?? "Unknown"}
                onTerminate={() => auth.terminateSession(session.id)}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Session policy"
          subtitle="Deliberately generous: a timeout short enough to be a nuisance gets worked around."
        />
        <dl className="grid gap-4 px-gutter pb-gutter sm:grid-cols-2">
          <div>
            <dt className="font-mono text-label-caps uppercase text-on-surface-variant">
              Idle timeout
            </dt>
            <dd className="text-body-md text-on-surface">
              {formatDuration(DEFAULT_SESSION_POLICY.idleTimeoutMillis)}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-label-caps uppercase text-on-surface-variant">
              Maximum session
            </dt>
            <dd className="text-body-md text-on-surface">
              {formatDuration(DEFAULT_SESSION_POLICY.absoluteTimeoutMillis)}
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}

function SessionRow({
  session,
  now,
  isCurrent,
  userName,
  onTerminate,
}: {
  session: Session;
  now: Date;
  isCurrent: boolean;
  userName: string;
  onTerminate: () => void;
}) {
  const status = sessionStatus(session, now, DEFAULT_SESSION_POLICY);
  const idle = idleForMillis(session, now);

  return (
    <li className="flex flex-wrap items-center gap-4 px-gutter py-3">
      <MonitorSmartphone
        aria-hidden="true"
        className={cn(
          "size-5 shrink-0",
          status === "idle" ? "text-warning" : "text-on-surface-variant",
        )}
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-body-md font-semibold text-on-surface">
            {userName}
          </span>
          {isCurrent && <StatusChip tone="in-progress" label="This device" />}
          {status === "idle" && <StatusChip tone="waiting" label="Idle" />}
        </div>
        <p className="text-body-sm text-on-surface-variant">
          {session.device} · signed in{" "}
          {session.startedAt.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p className="font-mono text-label-caps uppercase text-on-surface-variant">
          Last activity
        </p>
        <p className="text-body-sm text-on-surface">
          {idle < 60_000 ? "Just now" : `${formatDuration(idle)} ago`}
        </p>
      </div>

      <Button
        variant="danger"
        size="sm"
        icon={<LogOut className="size-4" />}
        onClick={onTerminate}
      >
        {isCurrent ? "Sign out" : "End session"}
      </Button>
    </li>
  );
}
