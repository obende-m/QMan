import { useMemo } from "react";
import {
  Activity,
  BellRing,
  CircleCheck,
  MonitorPlay,
  Radio,
  TriangleAlert,
  UserRound,
  Volume2,
} from "lucide-react";
import type {
  ChannelHealth,
  DeviceHealth,
  StaffPresence,
  StationHealth,
} from "@qman/domain";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { StatusChip } from "../../components/ui/StatusChip.js";
import { Button } from "../../components/ui/Button.js";
import { cn } from "../../components/ui/cn.js";
import type { ClinicStore } from "../../data/clinic-store.js";
import type { OperationsStore } from "../../data/operations-store.js";
import { CHANNEL_LABELS } from "../../data/operations-store.js";
import { slaFor, stationName, userName } from "../../data/demo-clinic.js";
import { formatDuration, useClinic, useNow } from "../../data/useClinic.js";
import { useOperations } from "../../data/useOperations.js";

/**
 * The Operational Command Centre.
 *
 * The Manager Dashboard answers "how is the clinic running". This answers a
 * narrower and more urgent question: "what is broken right now, and does anyone
 * know yet". A supervisor arriving at 10:30 should be able to read it in ten
 * seconds and know whether to intervene.
 *
 * It is built around one ordering principle: everything that has a patient
 * consequence is above everything that does not. A dead display board is a room
 * full of people who cannot see their number, so it ranks alongside an SLA
 * breach — not in a diagnostics tab.
 *
 * It is not infrastructure monitoring. There is no CPU, no memory, no uptime
 * graph. Every signal here is one QMan uniquely knows and a manager can act on.
 */
export interface CommandCentreProps {
  store?: ClinicStore;
  operations?: OperationsStore;
  onOpenStation?: (stationId: string) => void;
}

export function CommandCentre({
  store: injected,
  operations: injectedOps,
  onOpenStation,
}: CommandCentreProps = {}) {
  const clinic = useClinic(injected);
  const ops = useOperations(injectedOps);
  const now = useNow(2000);
  const version = clinic.getVersion() + ops.getVersion();

  const view = useMemo(() => {
    const health = clinic.stationHealth(now);
    const stationsWithWaiting = health
      .filter((station) => station.waiting > 0)
      .map((station) => station.stationId);

    return {
      health,
      bottlenecks: clinic.bottlenecks(now),
      pulse: clinic.pulse(now),
      devices: ops.unhealthyDevices(now),
      allDevices: ops.devices,
      channels: ops.channelHealth(now),
      presence: ops.presence(now),
      unstaffed: ops.unstaffedStations(stationsWithWaiting, now),
      announcements: ops.announcements.slice(0, 6),
      audit: ops.audit.slice(0, 8),
    };
  }, [clinic, ops, now, version]);

  const alerts = buildAlerts(view, now);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-headline-lg-mobile font-semibold tracking-tight text-on-surface md:text-headline-lg">
            Command Centre
          </h1>
          <p className="mt-1 text-body-md text-on-surface-variant">
            Everything that needs a decision, before a patient has to ask.
          </p>
        </div>
        <span className="flex items-center gap-2 rounded-full border border-outline-variant px-3 py-1.5 text-body-sm text-on-surface-variant">
          <Radio aria-hidden="true" className="size-4 text-tertiary" />
          Live · {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>

      <AlertStrip alerts={alerts} {...(onOpenStation ? { onOpenStation } : {})} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Pulse label="Waiting" value={view.pulse.waiting} icon={<UserRound className="size-4" />} />
        <Pulse label="Being served" value={view.pulse.beingServed} icon={<Activity className="size-4" />} />
        <Pulse label="Completed today" value={view.pulse.completedToday} icon={<CircleCheck className="size-4" />} />
        <Pulse
          label="Avg wait"
          value={
            view.pulse.averageWaitMillis === null
              ? "—"
              : formatDuration(view.pulse.averageWaitMillis)
          }
          icon={<Activity className="size-4" />}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <QueueHealth
          health={view.health}
          unstaffed={view.unstaffed}
          {...(onOpenStation ? { onOpenStation } : {})}
        />
        <div className="space-y-6">
          <DeviceHealthCard devices={view.devices} total={view.allDevices.length} />
          <ChannelHealthCard channels={view.channels} />
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <PresenceCard presence={view.presence} />
        <AnnouncementsCard announcements={view.announcements} />
      </div>

      <AuditCard audit={view.audit} />
    </div>
  );
}

// ------------------------------------------------------------------- alerts

interface Alert {
  id: string;
  severity: "critical" | "warning";
  title: string;
  detail: string;
  stationId?: string;
}

/**
 * Alerts are ranked by patient impact, not by subsystem.
 *
 * An offline display board outranks a station approaching its SLA because the
 * first is already affecting everyone in the room while the second is still
 * only a risk.
 */
function buildAlerts(
  view: {
    bottlenecks: readonly StationHealth[];
    devices: readonly DeviceHealth[];
    channels: readonly ChannelHealth[];
    unstaffed: readonly string[];
  },
  now: Date,
): Alert[] {
  const alerts: Alert[] = [];

  for (const device of view.devices) {
    if (device.status !== "offline") continue;
    alerts.push({
      id: `device-${device.heartbeat.deviceId}`,
      severity: "critical",
      title: `${device.heartbeat.name} is offline`,
      detail: `No contact for ${formatDuration(device.silentForMillis)}. Patients in that area cannot see their number.`,
    });
  }

  for (const stationId of view.unstaffed) {
    alerts.push({
      id: `unstaffed-${stationId}`,
      severity: "critical",
      title: `${stationName(stationId as never)} has nobody serving`,
      detail: "Patients are waiting and no member of staff is active here.",
      stationId,
    });
  }

  for (const station of view.bottlenecks) {
    if (station.status !== "breached") continue;
    alerts.push({
      id: `sla-${station.stationId}`,
      severity: "critical",
      title: `${stationName(station.stationId)} is over its wait target`,
      detail: `Longest wait ${formatDuration(station.longestWaitMillis)} against a ${formatDuration(
        slaFor(station.stationId).targetWaitMillis,
      )} target.`,
      stationId: station.stationId,
    });
  }

  for (const channel of view.channels) {
    if (channel.healthy) continue;
    alerts.push({
      id: `channel-${channel.channel}`,
      severity: "warning",
      title: `${CHANNEL_LABELS[channel.channel]} notifications are failing`,
      detail: `${channel.failed} of ${channel.failed + channel.delivered} recent messages failed.`,
    });
  }

  for (const station of view.bottlenecks) {
    if (station.status !== "at_risk") continue;
    alerts.push({
      id: `risk-${station.stationId}`,
      severity: "warning",
      title: `${stationName(station.stationId)} is approaching its wait target`,
      detail: `Longest wait ${formatDuration(station.longestWaitMillis)}. Still time to intervene.`,
      stationId: station.stationId,
    });
  }

  for (const device of view.devices) {
    if (device.status !== "stale") continue;
    alerts.push({
      id: `stale-${device.heartbeat.deviceId}`,
      severity: "warning",
      title: `${device.heartbeat.name} may have dropped`,
      detail: `Last seen ${formatDuration(device.silentForMillis)} ago.`,
    });
  }

  void now;
  return alerts;
}

function AlertStrip({
  alerts,
  onOpenStation,
}: {
  alerts: readonly Alert[];
  onOpenStation?: (stationId: string) => void;
}) {
  if (alerts.length === 0) {
    return (
      <Card className="border-tertiary/30 bg-tertiary/5">
        <div className="flex items-center gap-3 px-gutter py-5">
          <CircleCheck aria-hidden="true" className="size-6 shrink-0 text-tertiary" />
          <div>
            <h2 className="text-title-md font-semibold text-on-surface">
              Nothing needs attention
            </h2>
            <p className="mt-0.5 text-body-sm text-on-surface-variant">
              Every queue is within target, all screens are live and
              notifications are delivering.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const critical = alerts.filter((a) => a.severity === "critical").length;

  return (
    <Card className={critical > 0 ? "border-error/40" : "border-warning/40"}>
      <header
        className={cn(
          "flex flex-wrap items-center gap-2 border-b px-gutter py-4",
          critical > 0
            ? "border-error/20 bg-error-container/40"
            : "border-warning/30 bg-warning-container/30",
        )}
      >
        <TriangleAlert
          aria-hidden="true"
          className={cn("size-5", critical > 0 ? "text-error" : "text-warning")}
        />
        <h2 className="text-title-md font-semibold text-on-surface">
          Needs attention
        </h2>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 font-mono text-label-caps uppercase",
            critical > 0 ? "bg-error text-on-error" : "bg-warning text-on-warning",
          )}
        >
          {alerts.length}
        </span>
      </header>

      <ul className="divide-y divide-outline-variant">
        {alerts.map((alert) => (
          <li
            key={alert.id}
            className="flex flex-wrap items-center gap-4 px-gutter py-4"
          >
            <span
              aria-hidden="true"
              className={cn(
                "h-10 w-1 shrink-0 rounded-full",
                alert.severity === "critical" ? "bg-error" : "bg-warning",
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="text-body-md font-semibold text-on-surface">
                {alert.title}
              </p>
              <p className="mt-0.5 text-body-sm text-on-surface-variant">
                {alert.detail}
              </p>
            </div>
            {alert.stationId && onOpenStation && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onOpenStation(alert.stationId!)}
              >
                Open station
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Pulse({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
}) {
  return (
    <article className="rounded-lg border border-outline-variant bg-surface-container-lowest p-gutter shadow-card">
      <p className="flex items-center gap-1.5 font-mono text-label-caps uppercase text-on-surface-variant">
        <span aria-hidden="true">{icon}</span>
        {label}
      </p>
      <p className="mt-2 text-display-lg font-bold tabular-nums text-on-surface">
        {value}
      </p>
    </article>
  );
}

function QueueHealth({
  health,
  unstaffed,
  onOpenStation,
}: {
  health: readonly StationHealth[];
  unstaffed: readonly string[];
  onOpenStation?: (stationId: string) => void;
}) {
  return (
    <Card>
      <CardHeader title="Queue health" subtitle="Every station, worst first." />
      <ul className="divide-y divide-outline-variant border-t border-outline-variant">
        {[...health]
          .sort((a, b) => b.longestWaitMillis - a.longestWaitMillis)
          .map((station) => (
            <li
              key={station.stationId}
              className="flex flex-wrap items-center gap-3 px-gutter py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenStation?.(station.stationId)}
                    disabled={!onOpenStation}
                    className="truncate text-body-md font-semibold text-on-surface hover:text-primary disabled:hover:text-on-surface"
                  >
                    {stationName(station.stationId)}
                  </button>
                  {station.status !== "healthy" && (
                    <StatusChip
                      tone={station.status === "breached" ? "urgent" : "waiting"}
                      label={station.status === "breached" ? "Over target" : "At risk"}
                    />
                  )}
                  {unstaffed.includes(station.stationId) && (
                    <StatusChip tone="urgent" label="Unstaffed" />
                  )}
                </div>
                <p className="mt-0.5 text-body-sm text-on-surface-variant">
                  {station.waiting} waiting · longest{" "}
                  {formatDuration(station.longestWaitMillis)}
                  {station.emergenciesWaiting > 0 &&
                    ` · ${station.emergenciesWaiting} emergency`}
                </p>
              </div>
              <div className="w-24 shrink-0">
                <div
                  role="meter"
                  aria-valuenow={Math.round(station.loadRatio * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${stationName(station.stationId)} load`}
                  className="h-2 w-full overflow-hidden rounded-full bg-surface-container-high"
                >
                  <div
                    className={cn(
                      "h-full rounded-full",
                      station.status === "breached"
                        ? "bg-error"
                        : station.status === "at_risk"
                          ? "bg-warning"
                          : "bg-tertiary",
                    )}
                    style={{ width: `${Math.max(3, station.loadRatio * 100)}%` }}
                  />
                </div>
              </div>
            </li>
          ))}
      </ul>
    </Card>
  );
}

function DeviceHealthCard({
  devices,
  total,
}: {
  devices: readonly DeviceHealth[];
  total: number;
}) {
  return (
    <Card>
      <CardHeader
        title="Display boards"
        subtitle={
          total === 0
            ? "No board has reported in."
            : `${total - devices.length} of ${total} reporting normally.`
        }
      />
      {total === 0 ? (
        // Honest rather than reassuring: an empty panel here means no board has
        // ever checked in, which is different from every board being healthy.
        <p className="px-gutter pb-gutter text-body-sm text-on-surface-variant">
          Boards report in while they are running. Open one to see it appear
          here.
        </p>
      ) : devices.length === 0 ? (
        <p className="flex items-center gap-2 px-gutter pb-gutter text-body-sm text-tertiary">
          <MonitorPlay aria-hidden="true" className="size-4" />
          Every screen is live.
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant border-t border-outline-variant">
          {devices.map((device) => (
            <li
              key={device.heartbeat.deviceId}
              className="flex items-center gap-3 px-gutter py-3"
            >
              <MonitorPlay
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0",
                  device.status === "offline" ? "text-error" : "text-warning",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-body-md text-on-surface">
                {device.heartbeat.name}
              </span>
              <StatusChip
                tone={device.status === "offline" ? "urgent" : "waiting"}
                label={device.status === "offline" ? "Offline" : "Unstable"}
              />
              <span className="shrink-0 font-mono text-label-caps uppercase text-on-surface-variant">
                {formatDuration(device.silentForMillis)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ChannelHealthCard({ channels }: { channels: readonly ChannelHealth[] }) {
  const active = channels.filter((c) => c.attempted > 0);

  return (
    <Card>
      <CardHeader
        title="Notification delivery"
        subtitle="Last 15 minutes. Declined permissions are not counted as failures."
      />
      {active.length === 0 ? (
        <p className="px-gutter pb-gutter text-body-sm text-on-surface-variant">
          No notifications attempted yet.
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant border-t border-outline-variant">
          {active.map((channel) => (
            <li
              key={channel.channel}
              className="flex items-center gap-3 px-gutter py-3"
            >
              <BellRing
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0",
                  channel.healthy ? "text-tertiary" : "text-error",
                )}
              />
              <span className="min-w-0 flex-1 text-body-md text-on-surface">
                {CHANNEL_LABELS[channel.channel]}
              </span>
              <span className="font-mono text-label-caps uppercase text-on-surface-variant">
                {channel.delivered}/{channel.attempted} delivered
                {channel.declined > 0 && ` · ${channel.declined} declined`}
              </span>
              {!channel.healthy && <StatusChip tone="urgent" label="Failing" />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PresenceCard({ presence }: { presence: readonly StaffPresence[] }) {
  return (
    <Card>
      <CardHeader
        title="Staff on the floor"
        subtitle="Inferred from actions taken, not from open sessions."
      />
      {presence.length === 0 ? (
        <p className="px-gutter pb-gutter text-body-sm text-on-surface-variant">
          Nobody has acted in QMan yet today.
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant border-t border-outline-variant">
          {presence.map((person) => (
            <li
              key={person.userId}
              className="flex items-center gap-3 px-gutter py-3"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  person.status === "active"
                    ? "bg-tertiary"
                    : person.status === "idle"
                      ? "bg-warning"
                      : "bg-outline",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-body-md text-on-surface">
                {userName(person.userId)}
              </span>
              <span className="truncate text-body-sm text-on-surface-variant">
                {person.stationId ? stationName(person.stationId) : "—"}
              </span>
              <span className="shrink-0 font-mono text-label-caps uppercase text-on-surface-variant">
                {person.status === "active"
                  ? "Active"
                  : `${formatDuration(person.idleForMillis)} idle`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AnnouncementsCard({
  announcements,
}: {
  announcements: readonly { id: string; text: string; occurredAt: Date }[];
}) {
  return (
    <Card>
      <CardHeader
        title="Recent announcements"
        subtitle="Exactly what was said, and when."
      />
      {announcements.length === 0 ? (
        <p className="px-gutter pb-gutter text-body-sm text-on-surface-variant">
          No announcements yet.
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant border-t border-outline-variant">
          {announcements.map((announcement) => (
            <li
              key={announcement.id}
              className="flex items-start gap-3 px-gutter py-3"
            >
              <Volume2
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-on-surface-variant"
              />
              <p className="min-w-0 flex-1 text-body-sm text-on-surface">
                “{announcement.text}”
              </p>
              <span className="shrink-0 font-mono text-label-caps uppercase text-on-surface-variant">
                {announcement.occurredAt.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AuditCard({
  audit,
}: {
  audit: readonly { id: string; summary: string; occurredAt: Date; actorId: string | null }[];
}) {
  return (
    <Card>
      <CardHeader
        title="Activity"
        subtitle="Every state change, as it happened."
      />
      {audit.length === 0 ? (
        <p className="px-gutter pb-gutter text-body-sm text-on-surface-variant">
          Nothing has happened yet.
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant border-t border-outline-variant">
          {audit.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center gap-3 px-gutter py-2.5"
            >
              <span className="min-w-0 flex-1 truncate text-body-sm text-on-surface">
                {entry.summary}
              </span>
              <span className="truncate text-body-sm text-on-surface-variant">
                {entry.actorId ? userName(entry.actorId) : "System"}
              </span>
              <span className="shrink-0 font-mono text-label-caps uppercase text-on-surface-variant">
                {entry.occurredAt.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
