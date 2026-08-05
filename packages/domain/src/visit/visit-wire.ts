/**
 * The aggregate's serialisation contract.
 *
 * One definition of how a visit crosses a network, owned by the domain rather
 * than by either side of it. The server writes this shape and the browser reads
 * it, so there is no pair of mappers to drift apart — and no moment where a
 * field added to `VisitState` is serialised by one side and silently dropped by
 * the other.
 *
 * **Why the browser receives state rather than a rendered view.** Queue
 * position, estimated wait, station health, bottlenecks and the clinic pulse
 * are pure functions in `@qman/domain`. Given the visits, a staff surface calls
 * exactly the same functions the server would. Shipping rendered numbers
 * instead would mean an endpoint per projection, and a second implementation of
 * each the first time a screen wanted one the API did not already return.
 *
 * That is not business logic in React. It is the domain, called from a store,
 * on state the server owns.
 *
 * **This shape is for authenticated staff only.** It carries the patient
 * reference, because a workstation legitimately shows who is being called. The
 * display board and patient tracker have their own projections and must never
 * be given this one.
 */
import { Visit, type VisitDependencies, type VisitState } from "./visit.js";
import type { QueueEntry } from "./queue-entry.js";

/** A queue entry with its instants as ISO strings. */
export interface QueueEntryWire {
  readonly id: string;
  readonly stationId: string;
  readonly queueNumber: number;
  readonly queueLabel: string;
  readonly queuePeriod: string;
  readonly status: string;
  readonly assignedUserId: string | null;
  readonly queuedAt: string;
  readonly calledAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly callAttempts: number;
  readonly skipped: boolean;
  readonly skipReason: string | null;
}

export interface VisitWire {
  readonly id: string;
  readonly journeyCode: string;
  readonly branchId: string;
  readonly workflowId: string;
  readonly patient: {
    readonly name: string;
    readonly hospitalNumber: string | null;
    readonly phone: string | null;
  };
  readonly status: string;
  readonly priority: string;
  readonly currentQueueEntryId: string | null;
  readonly queueEntries: readonly QueueEntryWire[];
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly closedAt: string | null;
}

function entryToWire(entry: QueueEntry): QueueEntryWire {
  return {
    id: entry.id,
    stationId: entry.stationId,
    queueNumber: entry.queueNumber,
    queueLabel: entry.queueLabel,
    queuePeriod: entry.queuePeriod,
    status: entry.status,
    assignedUserId: entry.assignedUserId,
    queuedAt: entry.queuedAt.toISOString(),
    calledAt: entry.calledAt?.toISOString() ?? null,
    startedAt: entry.startedAt?.toISOString() ?? null,
    completedAt: entry.completedAt?.toISOString() ?? null,
    callAttempts: entry.callAttempts,
    skipped: entry.skipped,
    skipReason: entry.skipReason,
  };
}

function entryFromWire(wire: QueueEntryWire): QueueEntry {
  return {
    id: wire.id,
    stationId: wire.stationId,
    queueNumber: wire.queueNumber,
    queueLabel: wire.queueLabel,
    queuePeriod: wire.queuePeriod,
    status: wire.status,
    assignedUserId: wire.assignedUserId,
    queuedAt: new Date(wire.queuedAt),
    calledAt: wire.calledAt === null ? null : new Date(wire.calledAt),
    startedAt: wire.startedAt === null ? null : new Date(wire.startedAt),
    completedAt: wire.completedAt === null ? null : new Date(wire.completedAt),
    callAttempts: wire.callAttempts,
    skipped: wire.skipped,
    skipReason: wire.skipReason,
  } as QueueEntry;
}

export function visitToWire(visit: Visit): VisitWire {
  const state = visit.toState();
  return {
    id: state.id,
    journeyCode: state.journeyCode,
    branchId: state.branchId,
    workflowId: state.workflowId,
    patient: {
      name: state.patient.name,
      hospitalNumber: state.patient.hospitalNumber,
      phone: state.patient.phone,
    },
    status: state.status,
    priority: state.priority,
    currentQueueEntryId: state.currentQueueEntryId,
    queueEntries: state.queueEntries.map(entryToWire),
    createdAt: state.createdAt.toISOString(),
    completedAt: state.completedAt?.toISOString() ?? null,
    closedAt: state.closedAt?.toISOString() ?? null,
  };
}

/**
 * Rebuilds a visit from the wire.
 *
 * `rehydrate` rather than `create`: this is a visit that already exists, and
 * reconstituting it must not emit a `visit.created` event. A store that
 * published one on every page load would fill the audit trail with admissions
 * that never happened.
 */
export function visitFromWire(wire: VisitWire, deps: VisitDependencies): Visit {
  const state: VisitState = {
    id: wire.id,
    journeyCode: wire.journeyCode,
    branchId: wire.branchId,
    workflowId: wire.workflowId,
    patient: wire.patient,
    status: wire.status,
    priority: wire.priority,
    currentQueueEntryId: wire.currentQueueEntryId,
    queueEntries: wire.queueEntries.map(entryFromWire),
    createdAt: new Date(wire.createdAt),
    completedAt: wire.completedAt === null ? null : new Date(wire.completedAt),
    closedAt: wire.closedAt === null ? null : new Date(wire.closedAt),
  } as VisitState;

  return Visit.rehydrate(state, deps);
}
