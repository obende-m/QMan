import { waitingSoFarMillis } from "../visit/queue-entry.js";
import type { QueueItem, StationWorklist } from "../queue/station-queue.js";
import type { StationId, UserId } from "../shared/ids.js";

/**
 * Operations Intelligence.
 *
 * Pure functions over the same worklist projections the staff screens use. The
 * manager dashboard therefore cannot disagree with the station screens — it is
 * reading the identical data through a different lens — and none of this logic
 * needs a database, a chart library or React to be tested.
 *
 * This is the third product from the PRD's "three products, one engine" split,
 * and it is deliberately the thinnest: analytics that require their own copy of
 * the data are analytics that drift.
 */

/** Per-station operational targets. Configuration, not constants. */
export interface StationSla {
  /** Wait beyond which the station is failing its own standard. */
  readonly targetWaitMillis: number;
  /** Queue depth at which the station is considered saturated. */
  readonly saturationPoint: number;
}

export type StationStatus = "healthy" | "at_risk" | "breached";

export interface StationHealth {
  readonly stationId: StationId;
  readonly waiting: number;
  readonly beingServed: number;
  /** How long the longest-waiting patient has been waiting, right now. */
  readonly longestWaitMillis: number;
  /** Mean wait of patients already served here today. Null if none yet. */
  readonly averageWaitMillis: number | null;
  readonly averageServiceMillis: number | null;
  readonly status: StationStatus;
  /** 0-1, queue depth against saturation. Drives the load bar. */
  readonly loadRatio: number;
  readonly emergenciesWaiting: number;
}

/**
 * Assesses one station.
 *
 * Status is driven by the *longest current wait* rather than the average.
 * An average hides the patient who has been sitting for 50 minutes behind nine
 * who were seen in five, and that patient is the one who complains — and the
 * one the manager needs to hear about before they do.
 *
 * "At risk" fires at 75% of target, which is the point at which intervention
 * can still prevent the breach rather than merely record it.
 */
export function assessStation(
  worklist: StationWorklist,
  sla: StationSla,
  now: Date,
): StationHealth {
  const longestWaitMillis = worklist.waiting.reduce(
    (longest, item) => Math.max(longest, waitingSoFarMillis(item.entry, now)),
    0,
  );

  const status: StationStatus =
    longestWaitMillis >= sla.targetWaitMillis
      ? "breached"
      : longestWaitMillis >= sla.targetWaitMillis * 0.75
        ? "at_risk"
        : "healthy";

  return {
    stationId: worklist.stationId,
    waiting: worklist.counts.waiting,
    beingServed: worklist.current ? 1 : 0,
    longestWaitMillis,
    averageWaitMillis: worklist.averageWaitMillis,
    averageServiceMillis: worklist.averageServiceMillis,
    status,
    loadRatio: Math.min(
      1,
      worklist.counts.waiting / Math.max(1, sla.saturationPoint),
    ),
    emergenciesWaiting: worklist.counts.emergencies,
  };
}

/**
 * Stations needing attention, worst first.
 *
 * Breached before at-risk, then by how long the longest-waiting patient has
 * been there. Healthy stations are excluded entirely — a control centre that
 * lists everything is a control centre nobody reads.
 */
export function rankBottlenecks(
  healths: readonly StationHealth[],
): StationHealth[] {
  const severity: Record<StationStatus, number> = {
    breached: 2,
    at_risk: 1,
    healthy: 0,
  };

  return healths
    .filter((health) => health.status !== "healthy")
    .sort((a, b) => {
      const bySeverity = severity[b.status] - severity[a.status];
      if (bySeverity !== 0) return bySeverity;
      return b.longestWaitMillis - a.longestWaitMillis;
    });
}

export interface LongestWaiting {
  readonly item: QueueItem;
  readonly stationId: StationId;
  readonly waitedMillis: number;
}

/**
 * The single patient who has been waiting longest anywhere in the hospital.
 *
 * A named individual rather than a statistic, because that is what makes a
 * manager act. "Average wait is 24 minutes" is a number; "Grace Mensah has been
 * in Laboratory for 51 minutes" is a decision.
 */
export function longestWaitingPatient(
  worklists: readonly StationWorklist[],
  now: Date,
): LongestWaiting | null {
  let worst: LongestWaiting | null = null;

  for (const worklist of worklists) {
    for (const item of worklist.waiting) {
      const waited = waitingSoFarMillis(item.entry, now);
      if (!worst || waited > worst.waitedMillis) {
        worst = { item, stationId: worklist.stationId, waitedMillis: waited };
      }
    }
  }

  return worst;
}

export interface StaffWorkload {
  readonly userId: UserId;
  /** Patients this member of staff has completed today. */
  readonly completed: number;
  /** Whether they currently have a patient in progress. */
  readonly active: boolean;
  readonly averageServiceMillis: number | null;
}

/**
 * Workload per member of staff, derived from queue entries.
 *
 * Deliberately reports throughput and mean service time without ranking anyone.
 * A raw leaderboard in a clinical setting rewards rushing patients, and the
 * fastest consultation is rarely the best one. Managers get the distribution;
 * what to do about it is a human judgement.
 */
export function staffWorkloads(
  worklists: readonly StationWorklist[],
): StaffWorkload[] {
  const byUser = new Map<
    UserId,
    { completed: number; active: boolean; durations: number[] }
  >();

  const ensure = (userId: UserId) => {
    const existing = byUser.get(userId);
    if (existing) return existing;
    const created = { completed: 0, active: false, durations: [] as number[] };
    byUser.set(userId, created);
    return created;
  };

  for (const worklist of worklists) {
    if (worklist.current?.entry.assignedUserId) {
      ensure(worklist.current.entry.assignedUserId).active = true;
    }
    for (const item of worklist.completedToday) {
      const userId = item.entry.assignedUserId;
      if (!userId) continue;
      const record = ensure(userId);
      record.completed += 1;
      if (item.entry.startedAt && item.entry.completedAt) {
        record.durations.push(
          item.entry.completedAt.getTime() - item.entry.startedAt.getTime(),
        );
      }
    }
  }

  return [...byUser.entries()]
    .map(([userId, record]) => ({
      userId,
      completed: record.completed,
      active: record.active,
      averageServiceMillis:
        record.durations.length > 0
          ? record.durations.reduce((sum, v) => sum + v, 0) /
            record.durations.length
          : null,
    }))
    .sort((a, b) => b.completed - a.completed);
}

export interface ClinicPulse {
  readonly waiting: number;
  readonly beingServed: number;
  readonly completedToday: number;
  readonly averageWaitMillis: number | null;
  readonly stationsBreached: number;
  readonly stationsAtRisk: number;
}

/** The headline numbers, computed from the same worklists as everything else. */
export function clinicPulse(
  healths: readonly StationHealth[],
  worklists: readonly StationWorklist[],
): ClinicPulse {
  const waits = worklists
    .flatMap((w) => w.completedToday)
    .map((item) =>
      item.entry.startedAt
        ? item.entry.startedAt.getTime() - item.entry.queuedAt.getTime()
        : null,
    )
    .filter((value): value is number => value !== null);

  return {
    waiting: healths.reduce((sum, h) => sum + h.waiting, 0),
    beingServed: healths.reduce((sum, h) => sum + h.beingServed, 0),
    completedToday: worklists.reduce(
      (sum, w) => sum + w.counts.completedToday,
      0,
    ),
    averageWaitMillis:
      waits.length > 0
        ? waits.reduce((sum, v) => sum + v, 0) / waits.length
        : null,
    stationsBreached: healths.filter((h) => h.status === "breached").length,
    stationsAtRisk: healths.filter((h) => h.status === "at_risk").length,
  };
}
