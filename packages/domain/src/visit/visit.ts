import { InvariantViolationError, ValidationError } from "../shared/errors.js";
import { nextStatus, type VisitStatus } from "./visit-status.js";
import {
  isOpen,
  serviceMillis,
  stageMillis,
  type QueueEntry,
} from "./queue-entry.js";
import { DEFAULT_PRIORITY, type Priority } from "./priority.js";
import type { Clock } from "../shared/clock.js";
import type { JourneyCode } from "../journey/journey-code.js";
import type { VisitEvent } from "../events/visit-events.js";
import type { WithoutEnvelope } from "../events/domain-event.js";
import type { QueueTicket } from "../queue/queue-number.js";
import {
  QueueEntryId,
  VisitId,
  type BranchId,
  type IdGenerator,
  type StationId,
  type UserId,
  type WorkflowId,
} from "../shared/ids.js";

/**
 * The minimum patient information QMan holds.
 *
 * Deliberately not a medical record. Clinical data stays in the HMS; QMan keeps
 * only what is needed to call a patient by name and reconcile them against the
 * HMS by number. Keeping this surface small is what makes QMan deployable
 * alongside an incumbent system without a data-ownership negotiation.
 */
export interface PatientReference {
  readonly name: string;
  readonly hospitalNumber: string | null;
  readonly phone: string | null;
}

/** Options common to every staff-initiated action. */
export interface ActionContext {
  readonly actorId: UserId | null;
  readonly reason?: string | null;
}

export interface VisitState {
  id: VisitId;
  journeyCode: JourneyCode;
  branchId: BranchId;
  workflowId: WorkflowId;
  patient: PatientReference;
  status: VisitStatus;
  priority: Priority;
  currentQueueEntryId: QueueEntryId | null;
  queueEntries: QueueEntry[];
  createdAt: Date;
  completedAt: Date | null;
  closedAt: Date | null;
}

export interface VisitDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The Visit aggregate — QMan's single source of truth.
 *
 * Queues, dashboards, display boards and the patient portal are all projections
 * of visits. Nothing outside this class mutates visit state, and every mutation
 * both passes the transition table and records an event. That pairing is what
 * makes the audit trail complete by construction rather than by discipline.
 */
export class Visit {
  #state: VisitState;
  readonly #deps: VisitDependencies;
  #pending: VisitEvent[] = [];

  private constructor(state: VisitState, deps: VisitDependencies) {
    this.#state = state;
    this.#deps = deps;
  }

  // ---------------------------------------------------------------- lifecycle

  static create(
    input: {
      journeyCode: JourneyCode;
      branchId: BranchId;
      workflowId: WorkflowId;
      patient: PatientReference;
      priority?: Priority;
    },
    deps: VisitDependencies,
    context: ActionContext = { actorId: null },
  ): Visit {
    const name = input.patient.name.trim();
    if (name.length === 0) {
      throw new ValidationError("A visit requires a patient name.");
    }

    const now = deps.clock.now();
    const priority = input.priority ?? DEFAULT_PRIORITY;

    const visit = new Visit(
      {
        id: VisitId(deps.ids.next()),
        journeyCode: input.journeyCode,
        branchId: input.branchId,
        workflowId: input.workflowId,
        patient: { ...input.patient, name },
        status: "created",
        priority,
        currentQueueEntryId: null,
        queueEntries: [],
        createdAt: now,
        completedAt: null,
        closedAt: null,
      },
      deps,
    );

    visit.#record({
      type: "visit.created",
      visitId: visit.#state.id,
      branchId: input.branchId,
      actorId: context.actorId,
      occurredAt: now,
      payload: {
        journeyCode: input.journeyCode,
        workflowId: input.workflowId,
        patientName: name,
        hospitalNumber: input.patient.hospitalNumber,
        priority,
      },
    });

    return visit;
  }

  /** Reconstitutes a visit from storage. Emits nothing. */
  static rehydrate(state: VisitState, deps: VisitDependencies): Visit {
    return new Visit(state, deps);
  }

  // --------------------------------------------------------------- accessors

  get id(): VisitId {
    return this.#state.id;
  }
  get journeyCode(): JourneyCode {
    return this.#state.journeyCode;
  }
  get branchId(): BranchId {
    return this.#state.branchId;
  }
  get workflowId(): WorkflowId {
    return this.#state.workflowId;
  }
  get status(): VisitStatus {
    return this.#state.status;
  }
  get priority(): Priority {
    return this.#state.priority;
  }
  get patient(): PatientReference {
    return this.#state.patient;
  }
  get createdAt(): Date {
    return this.#state.createdAt;
  }
  get completedAt(): Date | null {
    return this.#state.completedAt;
  }
  get queueEntries(): readonly QueueEntry[] {
    return this.#state.queueEntries;
  }

  /** The station the visit is attached to right now, if any. */
  get currentStationId(): StationId | null {
    return this.currentEntry?.stationId ?? null;
  }

  get currentEntry(): QueueEntry | undefined {
    const id = this.#state.currentQueueEntryId;
    if (!id) return undefined;
    return this.#state.queueEntries.find((e) => e.id === id);
  }

  /** Distinct stations this visit has completed work at. */
  get stationsVisited(): number {
    return new Set(
      this.#state.queueEntries
        .filter((e) => e.status === "completed")
        .map((e) => e.stationId),
    ).size;
  }

  /** Snapshot for persistence. Callers must not mutate the result. */
  toState(): Readonly<VisitState> {
    return this.#state;
  }

  // ------------------------------------------------------------------ actions

  /**
   * Places the visit into a station's queue. Used for the first stage; routing
   * between stations goes through `routeTo`, which calls this internally.
   */
  enqueue(
    stationId: StationId,
    ticket: QueueTicket,
    context: ActionContext = { actorId: null },
  ): QueueEntry {
    const status = nextStatus(this.#state.status, "enqueue");
    const entry = this.#openEntry(stationId, ticket, null, context);
    this.#state.status = status;
    return entry;
  }

  /** Announces the patient. Repeated calls are recalls. */
  call(
    calledBy: UserId,
    context: ActionContext = { actorId: null },
  ): QueueEntry {
    const action = this.#state.status === "called" ? "recall" : "call";
    const status = nextStatus(this.#state.status, action);
    const entry = this.#requireOpenEntry("call");
    this.#state.status = status;

    const now = this.#deps.clock.now();
    entry.status = "called";
    entry.assignedUserId = calledBy;
    entry.callAttempts += 1;
    entry.calledAt ??= now;

    this.#record({
      type: "visit.called",
      visitId: this.#state.id,
      branchId: this.#state.branchId,
      actorId: context.actorId ?? calledBy,
      occurredAt: now,
      payload: {
        queueEntryId: entry.id,
        stationId: entry.stationId,
        calledBy,
        callAttempt: entry.callAttempts,
      },
    });

    return entry;
  }

  /** The patient presented and service began. Starts the service-time clock. */
  startService(
    servedBy: UserId,
    context: ActionContext = { actorId: null },
  ): QueueEntry {
    const status = nextStatus(this.#state.status, "start");
    const entry = this.#requireOpenEntry("start");
    this.#state.status = status;

    const now = this.#deps.clock.now();
    entry.status = "in_progress";
    entry.assignedUserId = servedBy;
    entry.startedAt = now;

    this.#record({
      type: "visit.service_started",
      visitId: this.#state.id,
      branchId: this.#state.branchId,
      actorId: context.actorId ?? servedBy,
      occurredAt: now,
      payload: {
        queueEntryId: entry.id,
        stationId: entry.stationId,
        servedBy,
        waitedMillis: now.getTime() - entry.queuedAt.getTime(),
      },
    });

    return entry;
  }

  /**
   * The patient was called but did not present. They stay in the queue, flagged,
   * so the station can move on without losing them — the single most common
   * real-world event that naive queue systems handle by deleting the ticket.
   */
  skip(context: ActionContext = { actorId: null }): QueueEntry {
    const status = nextStatus(this.#state.status, "skip");
    const entry = this.#requireOpenEntry("skip");
    if (entry.status !== "called") {
      throw new InvariantViolationError(
        "QUEUE_ENTRY_NOT_CALLED",
        "Only a patient who has been called can be skipped.",
        { queueEntryId: entry.id, status: entry.status },
      );
    }
    this.#state.status = status;

    const now = this.#deps.clock.now();
    entry.status = "waiting";
    entry.skipped = true;
    entry.skipReason = context.reason ?? null;

    this.#record({
      type: "visit.skipped",
      visitId: this.#state.id,
      branchId: this.#state.branchId,
      actorId: context.actorId,
      occurredAt: now,
      payload: {
        queueEntryId: entry.id,
        stationId: entry.stationId,
        reason: context.reason ?? null,
      },
    });

    return entry;
  }

  /**
   * Moves the visit to another station. Atomically closes the current queue
   * entry and opens the next, so the visit is never between queues.
   */
  routeTo(
    toStationId: StationId,
    ticket: QueueTicket,
    options: ActionContext & { followedWorkflow?: boolean } = { actorId: null },
  ): QueueEntry {
    const status = nextStatus(this.#state.status, "route");
    const from = this.#requireOpenEntry("route");
    if (from.stationId === toStationId) {
      throw new InvariantViolationError(
        "ROUTE_TO_SAME_STATION",
        "A visit cannot be routed to the station it is already at.",
        { stationId: toStationId },
      );
    }

    this.#state.status = status;
    const now = this.#deps.clock.now();
    this.#closeEntry(from, now, context(options));

    this.#record({
      type: "visit.routed",
      visitId: this.#state.id,
      branchId: this.#state.branchId,
      actorId: options.actorId,
      occurredAt: now,
      payload: {
        fromStationId: from.stationId,
        toStationId,
        reason: options.reason ?? null,
        followedWorkflow: options.followedWorkflow ?? true,
      },
    });

    return this.#openEntry(
      toStationId,
      ticket,
      from.stationId,
      context(options),
    );
  }

  /** Ends the journey. Closes any open queue entry first. */
  complete(context: ActionContext = { actorId: null }): void {
    const entry = this.currentEntry;
    const status = nextStatus(this.#state.status, "complete");
    this.#state.status = status;

    const now = this.#deps.clock.now();
    if (entry && isOpen(entry)) {
      this.#closeEntry(entry, now, context);
    }
    this.#state.currentQueueEntryId = null;
    this.#state.completedAt = now;

    this.#record({
      type: "visit.completed",
      visitId: this.#state.id,
      branchId: this.#state.branchId,
      actorId: context.actorId,
      occurredAt: now,
      payload: {
        totalMillis: now.getTime() - this.#state.createdAt.getTime(),
        stationsVisited: this.stationsVisited,
      },
    });
  }

  cancel(context: ActionContext = { actorId: null }): void {
    this.#state.status = nextStatus(this.#state.status, "cancel");

    const now = this.#deps.clock.now();
    const entry = this.currentEntry;
    if (entry && isOpen(entry)) {
      entry.status = "cancelled";
      entry.completedAt = now;
    }
    this.#state.currentQueueEntryId = null;

    this.#record({
      type: "visit.cancelled",
      visitId: this.#state.id,
      branchId: this.#state.branchId,
      actorId: context.actorId,
      occurredAt: now,
      payload: { reason: context.reason ?? null },
    });
  }

  /** Seals the record. After this the visit is immutable. */
  close(context: ActionContext = { actorId: null }): void {
    this.#state.status = nextStatus(this.#state.status, "close");
    const now = this.#deps.clock.now();
    this.#state.closedAt = now;

    this.#record({
      type: "visit.closed",
      visitId: this.#state.id,
      branchId: this.#state.branchId,
      actorId: context.actorId,
      occurredAt: now,
      payload: {},
    });
  }

  changePriority(
    to: Priority,
    context: ActionContext = { actorId: null },
  ): void {
    const from = this.#state.priority;
    if (from === to) return;
    if (this.#state.status === "closed") {
      throw new InvariantViolationError(
        "VISIT_CLOSED",
        "A closed visit cannot be re-prioritised.",
        { visitId: this.#state.id },
      );
    }

    this.#state.priority = to;
    this.#record({
      type: "visit.priority_changed",
      visitId: this.#state.id,
      branchId: this.#state.branchId,
      actorId: context.actorId,
      occurredAt: this.#deps.clock.now(),
      payload: { from, to, reason: context.reason ?? null },
    });
  }

  // ------------------------------------------------------------------- events

  /**
   * Hands off recorded events for publication and clears the buffer.
   *
   * The application layer pulls these only after the repository has committed,
   * so no consumer can observe an event for a state change that was rolled back.
   */
  pullEvents(): VisitEvent[] {
    const events = this.#pending;
    this.#pending = [];
    return events;
  }

  get hasPendingEvents(): boolean {
    return this.#pending.length > 0;
  }

  // ------------------------------------------------------------------ private

  /**
   * Stamps the Journey Code onto every event before buffering it, so no caller
   * can forget it and every subscriber can correlate without a lookup.
   */
  #record(event: WithoutEnvelope<VisitEvent>): void {
    this.#pending.push({
      ...event,
      journeyCode: this.#state.journeyCode,
    } as VisitEvent);
  }

  #openEntry(
    stationId: StationId,
    ticket: QueueTicket,
    fromStationId: StationId | null,
    ctx: ActionContext,
  ): QueueEntry {
    if (!Number.isInteger(ticket.ordinal) || ticket.ordinal < 1) {
      throw new ValidationError("Queue number must be a positive integer.", {
        ordinal: ticket.ordinal,
      });
    }
    if (ticket.label.trim().length === 0) {
      throw new ValidationError("A queue ticket must carry a printable label.", {
        ordinal: ticket.ordinal,
      });
    }

    const now = this.#deps.clock.now();
    const entry: QueueEntry = {
      id: QueueEntryId(this.#deps.ids.next()),
      stationId,
      queueNumber: ticket.ordinal,
      queueLabel: ticket.label,
      queuePeriod: ticket.periodKey,
      status: "waiting",
      assignedUserId: null,
      queuedAt: now,
      calledAt: null,
      startedAt: null,
      completedAt: null,
      callAttempts: 0,
      skipped: false,
      skipReason: null,
    };

    this.#state.queueEntries.push(entry);
    this.#state.currentQueueEntryId = entry.id;

    this.#record({
      type: "visit.queued",
      visitId: this.#state.id,
      branchId: this.#state.branchId,
      actorId: ctx.actorId,
      occurredAt: now,
      payload: {
        queueEntryId: entry.id,
        stationId,
        queueNumber: ticket.ordinal,
        queueLabel: ticket.label,
        priority: this.#state.priority,
        fromStationId,
      },
    });

    return entry;
  }

  #closeEntry(entry: QueueEntry, now: Date, ctx: ActionContext): void {
    entry.status = "completed";
    entry.completedAt = now;
    // A station that completes a visit without formally starting service still
    // produces a service duration, otherwise analytics would show a zero-length
    // stage. Treat the call as the start when nothing else is recorded.
    entry.startedAt ??= entry.calledAt ?? now;

    this.#record({
      type: "visit.stage_completed",
      visitId: this.#state.id,
      branchId: this.#state.branchId,
      actorId: ctx.actorId,
      occurredAt: now,
      payload: {
        queueEntryId: entry.id,
        stationId: entry.stationId,
        serviceMillis: serviceMillis(entry) ?? 0,
        stageMillis: stageMillis(entry) ?? 0,
      },
    });
  }

  #requireOpenEntry(action: string): QueueEntry {
    const entry = this.currentEntry;
    if (!entry || !isOpen(entry)) {
      throw new InvariantViolationError(
        "NO_OPEN_QUEUE_ENTRY",
        `Cannot "${action}": this visit is not currently in any queue.`,
        { visitId: this.#state.id, action },
      );
    }
    return entry;
  }
}

/** Narrows a routing options object down to a plain ActionContext. */
function context(options: ActionContext): ActionContext {
  return options.reason === undefined
    ? { actorId: options.actorId }
    : { actorId: options.actorId, reason: options.reason };
}
