/**
 * Background maintenance: closing visits, and pruning what only lives a day.
 *
 * **Why visits must close.** A visit that is completed but never closed stays
 * in every "active" query for ever — reception lists, boards, the Journey Code
 * uniqueness check — and its tracking token keeps working: a ticket in a
 * patient's pocket would show their queue status weeks later. Closing is what
 * retires the token, frees the code and seals the record.
 *
 * Two rules, both configurable:
 *
 * - a completed or cancelled visit is closed once its grace period has passed,
 *   which leaves time for a correction at the desk;
 * - a visit still open long after admission — the patient who left without
 *   being seen, the visit nobody completed — is cancelled with a reason that
 *   says so, then closed. Cancelling first keeps the transition table honest
 *   and puts the abandonment in the audit trail rather than hiding it.
 *
 * Each visit goes through the aggregate and the versioned save, exactly as a
 * staff action does, so a job running on two instances, or racing a member of
 * staff, loses cleanly on the conflicting visit and moves on.
 */
import type { Visit } from "@qman/domain";
import {
  ConcurrentModificationError,
  type IdempotencyRepository,
  type LockoutRepository,
  type VisitRepository,
} from "@qman/persistence";
import type { EventStream } from "./stream.js";
import type { Logger } from "./logging.js";
import { toNewEvent } from "./visit-events.js";
import { KEY_LIFETIME_MILLIS } from "./idempotency.js";

export const ABANDONED_REASON = "Not completed before the end of the operating day";

export interface ClosurePolicy {
  readonly closeAfterMinutes: number;
  readonly abandonAfterHours: number;
  /** Visits handled per run, so one run never holds the table for long. */
  readonly batchSize?: number;
}

export interface MaintenanceDependencies {
  readonly visits: VisitRepository;
  readonly stream?: EventStream;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly policy: ClosurePolicy;
  readonly idempotency?: IdempotencyRepository;
  readonly lockouts?: LockoutRepository;
}

export interface ClosureOutcome {
  readonly closed: number;
  readonly abandoned: number;
  readonly conflicts: number;
}

function seal(visit: Visit): "closed" | "abandoned" {
  if (visit.status === "completed" || visit.status === "cancelled") {
    visit.close({ actorId: null });
    return "closed";
  }
  visit.cancel({ actorId: null, reason: ABANDONED_REASON });
  visit.close({ actorId: null });
  return "abandoned";
}

export async function closeVisits(deps: MaintenanceDependencies): Promise<ClosureOutcome> {
  const at = deps.now();
  const candidates = await deps.visits.awaitingClosure({
    finishedBefore: new Date(at.getTime() - deps.policy.closeAfterMinutes * 60_000),
    admittedBefore: new Date(at.getTime() - deps.policy.abandonAfterHours * 3_600_000),
    limit: deps.policy.batchSize ?? 200,
  });

  let closed = 0;
  let abandoned = 0;
  let conflicts = 0;

  for (const { hospitalId, visit } of candidates) {
    let outcome: "closed" | "abandoned";
    try {
      outcome = seal(visit);
    } catch (error) {
      visit.pullEvents();
      deps.logger.warn("visit could not be closed", {
        hospitalId,
        visitId: visit.id,
        status: visit.status,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const records = visit.pullEvents().map((event) => toNewEvent(event, { hospitalId, sessionId: null }));
    try {
      await deps.visits.save(visit, records);
    } catch (error) {
      if (error instanceof ConcurrentModificationError) {
        // Someone acted on it a moment ago, or another instance closed it.
        // Either way the next run sees its current state.
        conflicts += 1;
        continue;
      }
      throw error;
    }

    for (const record of records) {
      deps.stream?.publish({
        ...record,
        id: `${visit.id}-${record.occurredAt.getTime()}-${record.type}`,
        sequence: 0,
        recordedAt: record.occurredAt,
      });
    }
    if (outcome === "closed") closed += 1;
    else abandoned += 1;
  }

  if (closed + abandoned + conflicts > 0) {
    deps.logger.info("visits closed", { closed, abandoned, conflicts });
  }
  return { closed, abandoned, conflicts };
}

/** Removes retry records past their lifetime, and stale sign-in counters. */
export async function prune(deps: MaintenanceDependencies): Promise<void> {
  const at = deps.now();
  const keys = (await deps.idempotency?.prune(new Date(at.getTime() - KEY_LIFETIME_MILLIS))) ?? 0;
  const counters = (await deps.lockouts?.prune(new Date(at.getTime() - 24 * 3_600_000))) ?? 0;
  if (keys + counters > 0) deps.logger.info("pruned", { idempotencyKeys: keys, loginCounters: counters });
}

/**
 * Runs maintenance on an interval, never overlapping itself.
 *
 * Returns a stop function for graceful shutdown. A failed run is logged and the
 * next one tries again; a maintenance fault must not take the API down with it.
 */
export function scheduleMaintenance(deps: MaintenanceDependencies, intervalMillis: number): () => Promise<void> {
  let running: Promise<void> | null = null;
  const run = (): void => {
    if (running !== null) return;
    running = (async () => {
      try {
        await closeVisits(deps);
        await prune(deps);
      } catch (error) {
        deps.logger.error("maintenance failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        running = null;
      }
    })();
  };

  const first = setTimeout(run, 10_000);
  const timer = setInterval(run, intervalMillis);
  first.unref?.();
  timer.unref?.();

  return async () => {
    clearTimeout(first);
    clearInterval(timer);
    if (running !== null) await running;
  };
}
