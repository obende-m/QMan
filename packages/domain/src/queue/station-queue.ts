import {
  DEFAULT_PRIORITY_WEIGHTS,
  priorityWeight,
  type Priority,
} from "../visit/priority.js";
import { waitingSoFarMillis, type QueueEntry } from "../visit/queue-entry.js";
import type { JourneyCode } from "../journey/journey-code.js";
import type { StationId, UserId, VisitId } from "../shared/ids.js";

/**
 * One row of a station's worklist: a queue entry joined to the few visit facts
 * staff need in order to act on it. This is a read model, assembled by the
 * application layer — the domain never queries.
 */
export interface QueueItem {
  readonly visitId: VisitId;
  readonly journeyCode: JourneyCode;
  readonly patientName: string;
  readonly priority: Priority;
  readonly entry: QueueEntry;
}

/**
 * A station's complete working view.
 *
 * The SAD calls this the Station Worklist and is explicit that queues are only
 * one section of it. Modelling the whole worklist here means the Doctor, Lab,
 * Vitals, Radiology and Pharmacy workspaces are one component with different
 * data, not five screens.
 */
export interface StationWorklist {
  readonly stationId: StationId;
  /** The patient currently called or being served, if any. */
  readonly current: QueueItem | null;
  /** Ordered exactly as the station should serve them. */
  readonly waiting: readonly QueueItem[];
  /** Called but absent — still owed service. */
  readonly skipped: readonly QueueItem[];
  readonly completedToday: readonly QueueItem[];
  readonly counts: {
    readonly waiting: number;
    readonly skipped: number;
    readonly completedToday: number;
    readonly emergencies: number;
  };
  /** Mean wait of patients served today, in millis. Null if none yet. */
  readonly averageWaitMillis: number | null;
  /** Mean service duration today, in millis. Null if none yet. */
  readonly averageServiceMillis: number | null;
}

/**
 * Queue ordering.
 *
 * Priority first, then arrival. The one subtlety is skipped patients: they keep
 * their priority but yield to peers who arrived and stayed, otherwise a patient
 * who steps out repeatedly would hold the front of the queue indefinitely. They
 * do not go to the back either — they keep their arrival time, so they are
 * served as soon as the patients already ahead of them clear.
 */
export function compareQueueItems(
  a: QueueItem,
  b: QueueItem,
  weights: Readonly<Record<Priority, number>> = DEFAULT_PRIORITY_WEIGHTS,
): number {
  const byPriority =
    priorityWeight(b.priority, weights) - priorityWeight(a.priority, weights);
  if (byPriority !== 0) return byPriority;

  const bySkipped = Number(a.entry.skipped) - Number(b.entry.skipped);
  if (bySkipped !== 0) return bySkipped;

  const byArrival = a.entry.queuedAt.getTime() - b.entry.queuedAt.getTime();
  if (byArrival !== 0) return byArrival;

  // Stable final tiebreak so two visits queued in the same millisecond do not
  // swap places between renders and make the display board flicker.
  return a.entry.queueNumber - b.entry.queueNumber;
}

export function orderQueue(
  items: readonly QueueItem[],
  weights?: Readonly<Record<Priority, number>>,
): QueueItem[] {
  return [...items].sort((a, b) => compareQueueItems(a, b, weights));
}

/** 1-based position of a visit in its station queue, or null if not waiting. */
export function positionOf(
  visitId: VisitId,
  ordered: readonly QueueItem[],
): number | null {
  const index = ordered.findIndex((item) => item.visitId === visitId);
  return index === -1 ? null : index + 1;
}

export function buildWorklist(
  stationId: StationId,
  items: readonly QueueItem[],
  options: {
    weights?: Readonly<Record<Priority, number>>;
    now?: Date;
  } = {},
): StationWorklist {
  const waiting: QueueItem[] = [];
  const skipped: QueueItem[] = [];
  const completed: QueueItem[] = [];
  let current: QueueItem | null = null;

  for (const item of items) {
    switch (item.entry.status) {
      case "called":
      case "in_progress":
        current = item;
        break;
      case "waiting":
        waiting.push(item);
        if (item.entry.skipped) skipped.push(item);
        break;
      case "completed":
        completed.push(item);
        break;
      case "skipped":
      case "cancelled":
        break;
    }
  }

  const orderedWaiting = orderQueue(waiting, options.weights);

  return {
    stationId,
    current,
    waiting: orderedWaiting,
    skipped: orderQueue(skipped, options.weights),
    completedToday: completed,
    counts: {
      waiting: orderedWaiting.length,
      skipped: skipped.length,
      completedToday: completed.length,
      emergencies: orderedWaiting.filter((i) => i.priority === "emergency")
        .length,
    },
    averageWaitMillis: mean(
      completed
        .map((i) =>
          i.entry.startedAt
            ? i.entry.startedAt.getTime() - i.entry.queuedAt.getTime()
            : null,
        )
        .filter((v): v is number => v !== null),
    ),
    averageServiceMillis: mean(
      completed
        .map((i) =>
          i.entry.startedAt && i.entry.completedAt
            ? i.entry.completedAt.getTime() - i.entry.startedAt.getTime()
            : null,
        )
        .filter((v): v is number => v !== null),
    ),
  };
}

/**
 * Estimated wait for a patient at a given queue position.
 *
 * Uses the station's observed mean service time rather than a configured
 * duration, so the estimate adapts to how the station is actually running
 * today. Falls back to the configured estimate before enough data exists.
 *
 * The estimate is deliberately conservative: patients tolerate being seen early
 * far better than being told 10 minutes and waiting 25, so the result is padded
 * and the caller is expected to present it as a range.
 */
export function estimateWaitMillis(input: {
  position: number;
  serversAvailable: number;
  observedServiceMillis: number | null;
  configuredServiceMillis: number;
}): number {
  const { position, observedServiceMillis, configuredServiceMillis } = input;
  const servers = Math.max(1, input.serversAvailable);
  const perPatient = observedServiceMillis ?? configuredServiceMillis;
  const ahead = Math.max(0, position - 1);
  const raw = (ahead / servers) * perPatient;
  return Math.round(raw * 1.15);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
