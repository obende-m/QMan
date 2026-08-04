import { IllegalTransitionError } from "../shared/errors.js";

/**
 * Visit lifecycle.
 *
 * The SAD lists Created → Queued → Called → In Progress → Completed Stage →
 * Transferred → Queued → Completed → Closed. Two adjustments were made while
 * preserving that intent:
 *
 * 1. "Completed Stage" and "Transferred" are not distinct resting states. They
 *    describe the same instant — the moment a station finishes with a visit and
 *    hands it on. Modelling them as two states creates a window in which a visit
 *    belongs to no queue and appears on no worklist, which in a busy hospital
 *    means a lost patient. Routing is therefore a single atomic action that ends
 *    one queue entry and opens the next, and the visit is only ever Queued or
 *    InProgress in between. The distinction survives where it actually matters:
 *    as StageCompleted and VisitRouted events on the audit trail.
 *
 * 2. Completed and Closed are kept separate. Completed means clinical work is
 *    finished; Closed means the record is sealed and no longer mutable. Keeping
 *    them apart preserves a window for corrections before the audit trail locks.
 */
export const VISIT_STATUSES = [
  "created",
  "queued",
  "called",
  "in_progress",
  "completed",
  "cancelled",
  "closed",
] as const;

export type VisitStatus = (typeof VISIT_STATUSES)[number];

/** Actions that can be attempted against a visit. */
export const VISIT_ACTIONS = [
  "enqueue",
  "call",
  "recall",
  "start",
  "skip",
  "requeue",
  "route",
  "complete",
  "cancel",
  "close",
  "reopen",
] as const;

export type VisitAction = (typeof VISIT_ACTIONS)[number];

/**
 * The single authoritative transition table.
 *
 * Every state change in QMan is validated here. Nothing else in the codebase is
 * permitted to mutate `Visit.status`, which is what makes the audit trail
 * trustworthy: an event exists for every transition because a transition cannot
 * happen anywhere else.
 */
const TRANSITIONS: Readonly<Record<VisitStatus, Partial<Record<VisitAction, VisitStatus>>>> =
  Object.freeze({
    created: {
      enqueue: "queued",
      cancel: "cancelled",
    },
    queued: {
      call: "called",
      // Re-queueing from Queued is a no-op state-wise but legal: it covers a
      // priority change or a manual move between stations while still waiting.
      requeue: "queued",
      route: "queued",
      cancel: "cancelled",
    },
    called: {
      // The patient answered the call and service began.
      start: "in_progress",
      // Called but absent: they go back into the queue, flagged as skipped.
      skip: "queued",
      // Called and did not hear it: call again, staying in Called.
      recall: "called",
      requeue: "queued",
      // Some stations (a display-only checkpoint) complete on call alone.
      route: "queued",
      complete: "completed",
      cancel: "cancelled",
    },
    in_progress: {
      route: "queued",
      complete: "completed",
      cancel: "cancelled",
    },
    completed: {
      close: "closed",
      // A completed visit can be reopened if a clinician needs the patient back
      // — a lab result arrives, a doctor wants a review. This is the "Doctor
      // Review" leg of the SAD's example journey.
      route: "queued",
    },
    cancelled: {
      close: "closed",
    },
    closed: {},
  });

export function canTransition(
  from: VisitStatus,
  action: VisitAction,
): boolean {
  return TRANSITIONS[from][action] !== undefined;
}

export function nextStatus(
  from: VisitStatus,
  action: VisitAction,
): VisitStatus {
  const to = TRANSITIONS[from][action];
  if (to === undefined) {
    throw new IllegalTransitionError(from, action, hintFor(from, action));
  }
  return to;
}

/** Returns the actions legal from a given state — drives UI button enablement. */
export function allowedActions(from: VisitStatus): VisitAction[] {
  return Object.keys(TRANSITIONS[from]) as VisitAction[];
}

export function isTerminal(status: VisitStatus): boolean {
  return status === "closed";
}

/** Staff-facing guidance, so the UI never has to invent an explanation. */
function hintFor(from: VisitStatus, action: VisitAction): string | undefined {
  if (from === "closed") {
    return "This visit is closed and can no longer be modified.";
  }
  if (from === "cancelled") {
    return "This visit was cancelled.";
  }
  if (action === "start" && from === "queued") {
    return "Call the patient before starting service.";
  }
  if (action === "call" && from === "in_progress") {
    return "This patient is already being served.";
  }
  return undefined;
}
