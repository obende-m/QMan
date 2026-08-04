import { useMemo } from "react";
import {
  Activity,
  CircleCheck,
  Clock,
  Stethoscope,
  TriangleAlert,
  UserRound,
  Users,
} from "lucide-react";
import type { StationHealth, StationStatus } from "@qman/domain";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { StatCard } from "../../components/ui/StatCard.js";
import { StatusChip } from "../../components/ui/StatusChip.js";
import { Button } from "../../components/ui/Button.js";
import { cn } from "../../components/ui/cn.js";
import type { ClinicStore } from "../../data/clinic-store.js";
import { slaFor, stationName, userName } from "../../data/demo-clinic.js";
import { formatDuration, useClinic, useNow } from "../../data/useClinic.js";

/**
 * The Manager Dashboard — an operational control centre, not a report.
 *
 * The distinction drives the layout. A report answers "how did we do"; a
 * control centre answers "what needs me right now". So the screen opens with
 * problems rather than totals: the stations missing their targets and the
 * single patient who has been waiting longest, both named and both actionable.
 * The aggregate numbers sit underneath, because by the time you are reading an
 * average, the patient who is going to complain has already been waiting.
 *
 * Everything here is derived from the same worklists the station screens read,
 * through pure functions in `@qman/domain`. The dashboard therefore cannot
 * disagree with the floor.
 */
export interface ManagerDashboardProps {
  store?: ClinicStore;
  onOpenStation?: (stationId: string) => void;
}

export function ManagerDashboard({
  store: injected,
  onOpenStation,
}: ManagerDashboardProps = {}) {
  const clinic = useClinic(injected);
  const now = useNow(5000);
  const version = clinic.getVersion();

  const { health, bottlenecks, pulse, longest, workloads } = useMemo(
    () => ({
      health: clinic.stationHealth(now),
      bottlenecks: clinic.bottlenecks(now),
      pulse: clinic.pulse(now),
      longest: clinic.longestWaiting(now),
      workloads: clinic.workloads(),
    }),
    // `now` ticks on a timer so live waits keep counting up even when nothing
    // in the clinic has changed.
    [clinic, version, now],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-headline-lg-mobile font-semibold tracking-tight text-on-surface md:text-headline-lg">
            Operations
          </h1>
          <p className="mt-1 text-body-md text-on-surface-variant">
            Live clinic status. Problems first.
          </p>
        </div>
        <span className="flex items-center gap-2 rounded-full border border-outline-variant px-3 py-1.5 text-body-sm text-on-surface-variant">
          <span className="size-2 rounded-full bg-tertiary" />
          Live
        </span>
      </div>

      {/* Problems before totals. */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Bottlenecks
          bottlenecks={bottlenecks}
          {...(onOpenStation ? { onOpenStation } : {})}
        />
        <LongestWaitingCard
          longest={longest}
          {...(onOpenStation ? { onOpenStation } : {})}
        />
      </div>

      <section aria-label="Clinic totals" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Patients waiting"
          value={pulse.waiting}
          icon={<Users className="size-4" />}
          accent={pulse.stationsBreached > 0 ? "critical" : "neutral"}
        />
        <StatCard
          label="Being served"
          value={pulse.beingServed}
          unit="active"
          icon={<Stethoscope className="size-4" />}
          accent="neutral"
        />
        <StatCard
          label="Completed today"
          value={pulse.completedToday}
          icon={<CircleCheck className="size-4" />}
          accent="positive"
        />
        <StatCard
          label="Avg wait today"
          value={
            pulse.averageWaitMillis === null
              ? "—"
              : Math.round(pulse.averageWaitMillis / 60_000)
          }
          {...(pulse.averageWaitMillis === null ? {} : { unit: "min" })}
          icon={<Clock className="size-4" />}
          accent={pulse.stationsAtRisk > 0 ? "warning" : "positive"}
        />
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <StationLoad health={health} {...(onOpenStation ? { onOpenStation } : {})} />
        <StaffWorkloadCard workloads={workloads} />
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<StationStatus, string> = {
  breached: "Over target",
  at_risk: "Approaching target",
  healthy: "Healthy",
};

function Bottlenecks({
  bottlenecks,
  onOpenStation,
}: {
  bottlenecks: readonly StationHealth[];
  onOpenStation?: (stationId: string) => void;
}) {
  if (bottlenecks.length === 0) {
    return (
      <Card className="border-tertiary/30 bg-tertiary/5">
        <div className="flex items-center gap-3 px-gutter py-5">
          <CircleCheck aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
          <div>
            <h2 className="text-title-md font-semibold text-on-surface">
              Every station is within target
            </h2>
            <p className="mt-0.5 text-body-sm text-on-surface-variant">
              No queue is approaching its wait target.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="border-error/30">
      <header className="flex items-center gap-2 border-b border-error/20 bg-error-container/40 px-gutter py-4">
        <TriangleAlert aria-hidden="true" className="size-5 text-error" />
        <h2 className="text-title-md font-semibold text-on-surface">
          Needs attention
        </h2>
        <span className="rounded-full bg-error px-2 py-0.5 font-mono text-label-caps uppercase text-on-error">
          {bottlenecks.length}
        </span>
      </header>

      <ul className="divide-y divide-outline-variant">
        {bottlenecks.map((station) => {
          const target = slaFor(station.stationId).targetWaitMillis;
          return (
            <li
              key={station.stationId}
              className="flex flex-wrap items-center gap-4 px-gutter py-4"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-10 w-1 shrink-0 rounded-full",
                  station.status === "breached" ? "bg-error" : "bg-warning",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body-md font-semibold text-on-surface">
                    {stationName(station.stationId)}
                  </span>
                  <StatusChip
                    tone={station.status === "breached" ? "urgent" : "waiting"}
                    label={STATUS_LABEL[station.status]}
                  />
                </div>
                <p className="mt-0.5 text-body-sm text-on-surface-variant">
                  Longest wait {formatDuration(station.longestWaitMillis)} against
                  a {formatDuration(target)} target · {station.waiting} waiting
                  {station.emergenciesWaiting > 0 &&
                    ` · ${station.emergenciesWaiting} emergency`}
                </p>
              </div>
              {onOpenStation && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onOpenStation(station.stationId)}
                >
                  Open station
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function LongestWaitingCard({
  longest,
  onOpenStation,
}: {
  longest: ReturnType<ClinicStore["longestWaiting"]>;
  onOpenStation?: (stationId: string) => void;
}) {
  return (
    <Card>
      <CardHeader
        title="Longest wait"
        subtitle="A specific case, not an average."
      />
      <div className="px-gutter pb-gutter">
        {longest ? (
          <>
            {/* Identified by station and ticket, never by name. An operational
                dashboard is read on a large screen in an open office, and a
                manager needs enough to act — which station, which ticket — not
                who the patient is. Identity lives one click away in the station
                workspace, behind that station's permissions. */}
            <p className="text-headline-lg font-bold tracking-tight text-on-surface">
              {stationName(longest.stationId)}
            </p>
            <p className="mt-2 font-mono text-label-caps uppercase text-on-surface-variant">
              Ticket
            </p>
            <p className="font-mono text-title-md font-semibold text-on-surface">
              {longest.item.entry.queueLabel}
            </p>
            <p className="mt-4 font-mono text-label-caps uppercase text-on-surface-variant">
              Waiting
            </p>
            <p
              className={cn(
                "text-display-lg font-bold tabular-nums",
                longest.waitedMillis >= slaFor(longest.stationId).targetWaitMillis
                  ? "text-error"
                  : "text-on-surface",
              )}
            >
              {formatDuration(longest.waitedMillis)}
            </p>
            {onOpenStation && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-4"
                onClick={() => onOpenStation(longest.stationId)}
              >
                Open station
              </Button>
            )}
          </>
        ) : (
          <p className="text-body-md text-on-surface-variant">
            Nobody is waiting anywhere in the clinic.
          </p>
        )}
      </div>
    </Card>
  );
}

function StationLoad({
  health,
  onOpenStation,
}: {
  health: readonly StationHealth[];
  onOpenStation?: (stationId: string) => void;
}) {
  const busiest = Math.max(1, ...health.map((h) => h.waiting));

  return (
    <Card>
      <CardHeader
        title="Queue length by station"
        subtitle="Current depth, average wait and average service time."
      />
      <div className="space-y-4 px-gutter pb-gutter">
        {health.map((station) => (
          <div key={station.stationId}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <button
                type="button"
                onClick={() => onOpenStation?.(station.stationId)}
                disabled={!onOpenStation}
                className="text-body-md font-semibold text-on-surface hover:text-primary disabled:hover:text-on-surface"
              >
                {stationName(station.stationId)}
              </button>
              <p className="font-mono text-label-caps uppercase text-on-surface-variant">
                {station.waiting} waiting
                {station.averageWaitMillis !== null &&
                  ` · avg wait ${formatDuration(station.averageWaitMillis)}`}
                {station.averageServiceMillis !== null &&
                  ` · avg service ${formatDuration(station.averageServiceMillis)}`}
              </p>
            </div>
            <div
              role="meter"
              aria-valuenow={station.waiting}
              aria-valuemin={0}
              aria-valuemax={busiest}
              aria-label={`${stationName(station.stationId)} queue length`}
              className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-container-high"
            >
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  station.status === "breached"
                    ? "bg-error"
                    : station.status === "at_risk"
                      ? "bg-warning"
                      : "bg-tertiary",
                )}
                style={{
                  width: `${Math.max(2, (station.waiting / busiest) * 100)}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function StaffWorkloadCard({
  workloads,
}: {
  workloads: ReturnType<ClinicStore["workloads"]>;
}) {
  return (
    <Card>
      <CardHeader
        title="Staff workload"
        subtitle="Throughput today. Not a ranking."
      />
      {workloads.length === 0 ? (
        <p className="px-gutter pb-gutter text-body-sm text-on-surface-variant">
          Nobody has completed a patient yet today.
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant border-t border-outline-variant">
          {workloads.map((staff) => (
            <li
              key={staff.userId}
              className="flex items-center gap-3 px-gutter py-3"
            >
              <span
                aria-hidden="true"
                className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-container-high text-on-surface-variant"
              >
                <UserRound className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-body-md font-semibold text-on-surface">
                    {userName(staff.userId)}
                  </span>
                  {staff.active && (
                    <StatusChip tone="in-progress" label="With patient" />
                  )}
                </div>
                {staff.averageServiceMillis !== null && (
                  <p className="text-body-sm text-on-surface-variant">
                    Avg {formatDuration(staff.averageServiceMillis)} per patient
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p className="font-mono text-label-caps uppercase text-on-surface-variant">
                  Seen
                </p>
                <p className="text-title-md font-semibold tabular-nums text-on-surface">
                  {staff.completed}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 border-t border-outline-variant px-gutter py-3">
        <Activity aria-hidden="true" className="size-4 text-on-surface-variant" />
        <p className="text-body-sm text-on-surface-variant">
          Throughput reflects case mix as much as pace.
        </p>
      </div>
    </Card>
  );
}
