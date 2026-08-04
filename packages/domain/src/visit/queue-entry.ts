import type { QueueEntryId, StationId, UserId } from "../shared/ids.js";

/**
 * A Queue Entry is one visit's stop at one station.
 *
 * Per the SAD: queues do not own visits, visits own queue entries. There is a
 * single queue_entries table for every station in the hospital — adding
 * Dialysis or MRI creates rows, never tables.
 */
export const QUEUE_ENTRY_STATUSES = [
  "waiting",
  "called",
  "in_progress",
  "skipped",
  "completed",
  "cancelled",
] as const;

export type QueueEntryStatus = (typeof QUEUE_ENTRY_STATUSES)[number];

export interface QueueEntry {
  readonly id: QueueEntryId;
  readonly stationId: StationId;
  /**
   * The ordinal within this station's series. The system allocates and sorts by
   * this; humans never see it directly.
   */
  readonly queueNumber: number;
  /**
   * The ticket as issued, e.g. "A-001" or "LAB-014".
   *
   * Stored rather than re-rendered on read. A patient holding a printed slip
   * must still match the display board after an administrator changes the
   * station's numbering format, and yesterday's audit trail must not
   * retroactively re-render under today's configuration.
   */
  readonly queueLabel: string;
  /**
   * The counting period this ordinal came from, kept so the series can be
   * rebuilt after a restore without guessing (see `recoveredOrdinal`).
   */
  readonly queuePeriod: string;
  status: QueueEntryStatus;
  assignedUserId: UserId | null;

  readonly queuedAt: Date;
  calledAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;

  /** How many times the patient has been called for this entry. */
  callAttempts: number;
  /** True once the patient has been skipped at least once at this station. */
  skipped: boolean;
  skipReason: string | null;
}

export function isOpen(entry: QueueEntry): boolean {
  return (
    entry.status === "waiting" ||
    entry.status === "called" ||
    entry.status === "in_progress"
  );
}

/**
 * Time from joining the queue to service starting. Null while still waiting —
 * callers computing live waiting times should use `waitingSoFar` instead.
 */
export function waitedMillis(entry: QueueEntry): number | null {
  if (!entry.startedAt) return null;
  return entry.startedAt.getTime() - entry.queuedAt.getTime();
}

export function waitingSoFarMillis(entry: QueueEntry, now: Date): number {
  const end = entry.startedAt ?? now;
  return end.getTime() - entry.queuedAt.getTime();
}

/** Time actually spent being served. Null if service never started. */
export function serviceMillis(entry: QueueEntry): number | null {
  if (!entry.startedAt || !entry.completedAt) return null;
  return entry.completedAt.getTime() - entry.startedAt.getTime();
}

/** Total time attached to the station, waiting plus service. */
export function stageMillis(entry: QueueEntry): number | null {
  if (!entry.completedAt) return null;
  return entry.completedAt.getTime() - entry.queuedAt.getTime();
}
