import type { BranchId, StationId, UserId, VisitId } from "../shared/ids.js";

/**
 * Operational telemetry.
 *
 * Scoped deliberately narrowly: this is not infrastructure monitoring. QMan has
 * no business reporting CPU load or disk usage — that is the hospital IT
 * department's job and a different product. What it must report is the handful
 * of facts that determine whether *patient flow* is working:
 *
 *   - Is the display board in the waiting room actually showing anything?
 *   - Did the "it's your turn" notification reach the patient?
 *   - Is anyone staffing Laboratory?
 *
 * Each of these has a direct patient consequence. A dead display board means a
 * room full of people who cannot see their number; a failing notification
 * channel means patients who miss their turn. Both are invisible without
 * telemetry, and both are the manager's problem before they are IT's.
 */

// ------------------------------------------------------------ device health

export type DeviceKind = "display_board" | "station_terminal";

/**
 * The last time a device checked in. Devices report; the server never polls —
 * a waiting-room screen behind a hospital firewall is often not addressable.
 */
export interface DeviceHeartbeat {
  readonly deviceId: string;
  readonly kind: DeviceKind;
  readonly name: string;
  readonly branchId: BranchId;
  readonly lastSeenAt: Date;
}

export type DeviceStatus = "online" | "stale" | "offline";

export interface DeviceHealthThresholds {
  /** Beyond this since last check-in, the device is questionable. */
  readonly staleAfterMillis: number;
  /** Beyond this, treat it as down. */
  readonly offlineAfterMillis: number;
}

/**
 * Defaults assume a 15-second heartbeat. Stale at 45s tolerates two missed
 * beats — enough to ride out a flaky wi-fi moment without crying wolf, since a
 * board that alarms every few minutes is a board nobody looks at.
 */
export const DEFAULT_DEVICE_THRESHOLDS: DeviceHealthThresholds = {
  staleAfterMillis: 45_000,
  offlineAfterMillis: 180_000,
};

export interface DeviceHealth {
  readonly heartbeat: DeviceHeartbeat;
  readonly status: DeviceStatus;
  readonly silentForMillis: number;
}

export function assessDevice(
  heartbeat: DeviceHeartbeat,
  now: Date,
  thresholds: DeviceHealthThresholds = DEFAULT_DEVICE_THRESHOLDS,
): DeviceHealth {
  const silentForMillis = Math.max(
    0,
    now.getTime() - heartbeat.lastSeenAt.getTime(),
  );

  const status: DeviceStatus =
    silentForMillis >= thresholds.offlineAfterMillis
      ? "offline"
      : silentForMillis >= thresholds.staleAfterMillis
        ? "stale"
        : "online";

  return { heartbeat, status, silentForMillis };
}

/** Devices needing attention, worst first. Healthy devices are excluded. */
export function unhealthyDevices(
  heartbeats: readonly DeviceHeartbeat[],
  now: Date,
  thresholds: DeviceHealthThresholds = DEFAULT_DEVICE_THRESHOLDS,
): DeviceHealth[] {
  return heartbeats
    .map((heartbeat) => assessDevice(heartbeat, now, thresholds))
    .filter((health) => health.status !== "online")
    .sort((a, b) => b.silentForMillis - a.silentForMillis);
}

// ------------------------------------------------------ notification health

export const NOTIFICATION_CHANNELS = [
  "browser",
  "voice",
  "sms",
  "whatsapp",
  "email",
] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export type DeliveryStatus =
  | "queued"
  | "delivered"
  | "failed"
  /** The recipient's device or browser cannot accept this channel. */
  | "unsupported"
  /** The recipient declined permission. Not a fault. */
  | "denied";

export interface NotificationAttempt {
  readonly id: string;
  readonly channel: NotificationChannel;
  readonly status: DeliveryStatus;
  readonly visitId: VisitId | null;
  readonly recipient: "patient" | "staff";
  readonly occurredAt: Date;
  readonly error: string | null;
}

export interface ChannelHealth {
  readonly channel: NotificationChannel;
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  /** Declined permission — reported separately so it is not read as a fault. */
  readonly declined: number;
  /** 0-1 over attempts that could have succeeded. Null when none were made. */
  readonly failureRate: number | null;
  readonly healthy: boolean;
}

/**
 * Per-channel delivery health over a recent window.
 *
 * `denied` and `unsupported` are excluded from the failure rate on purpose: a
 * patient who declined notification permission is not a broken channel, and
 * counting them as failures would keep the panel permanently red and train
 * managers to ignore it.
 */
export function channelHealth(
  attempts: readonly NotificationAttempt[],
  now: Date,
  options: { windowMillis?: number; failureThreshold?: number } = {},
): ChannelHealth[] {
  const { windowMillis = 15 * 60_000, failureThreshold = 0.2 } = options;
  const since = now.getTime() - windowMillis;

  return NOTIFICATION_CHANNELS.map((channel) => {
    const recent = attempts.filter(
      (a) => a.channel === channel && a.occurredAt.getTime() >= since,
    );

    const delivered = recent.filter((a) => a.status === "delivered").length;
    const failed = recent.filter((a) => a.status === "failed").length;
    const declined = recent.filter(
      (a) => a.status === "denied" || a.status === "unsupported",
    ).length;

    const deliverable = delivered + failed;
    const failureRate = deliverable === 0 ? null : failed / deliverable;

    return {
      channel,
      attempted: recent.length,
      delivered,
      failed,
      declined,
      failureRate,
      healthy: failureRate === null || failureRate < failureThreshold,
    };
  });
}

// ----------------------------------------------------------- staff presence

export type PresenceStatus = "active" | "idle" | "away";

export interface StaffActivity {
  readonly userId: UserId;
  readonly stationId: StationId | null;
  readonly lastActionAt: Date;
}

export interface StaffPresence {
  readonly userId: UserId;
  readonly stationId: StationId | null;
  readonly status: PresenceStatus;
  readonly idleForMillis: number;
}

/**
 * Presence is inferred from actions taken in QMan, not from a login session.
 *
 * A session says someone left a tab open; calling a patient says they are at
 * the desk. Only the second tells a manager whether Laboratory is staffed
 * right now, which is the question being asked.
 */
export function assessPresence(
  activity: StaffActivity,
  now: Date,
  options: { idleAfterMillis?: number; awayAfterMillis?: number } = {},
): StaffPresence {
  const { idleAfterMillis = 10 * 60_000, awayAfterMillis = 30 * 60_000 } = options;
  const idleForMillis = Math.max(0, now.getTime() - activity.lastActionAt.getTime());

  const status: PresenceStatus =
    idleForMillis >= awayAfterMillis
      ? "away"
      : idleForMillis >= idleAfterMillis
        ? "idle"
        : "active";

  return {
    userId: activity.userId,
    stationId: activity.stationId,
    status,
    idleForMillis,
  };
}

/**
 * Stations that have patients waiting but nobody actively working them.
 *
 * The most actionable signal in the whole module: a queue with nobody serving
 * it will not clear on its own, and it is invisible on a dashboard that only
 * reports queue length.
 */
export function unstaffedStations(input: {
  readonly stationsWithWaiting: readonly StationId[];
  readonly presence: readonly StaffPresence[];
}): StationId[] {
  const staffed = new Set(
    input.presence
      .filter((p) => p.status === "active" && p.stationId !== null)
      .map((p) => p.stationId as StationId),
  );

  return input.stationsWithWaiting.filter((stationId) => !staffed.has(stationId));
}
