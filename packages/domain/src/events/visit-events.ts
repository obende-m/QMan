import type { DomainEventEnvelope } from "./domain-event.js";
import type { JourneyCode } from "../journey/journey-code.js";
import type { Priority } from "../visit/priority.js";
import type {
  QueueEntryId,
  StationId,
  UserId,
  WorkflowId,
} from "../shared/ids.js";

export type VisitCreated = DomainEventEnvelope<
  "visit.created",
  {
    journeyCode: JourneyCode;
    workflowId: WorkflowId;
    patientName: string;
    hospitalNumber: string | null;
    priority: Priority;
  }
>;

export type VisitQueued = DomainEventEnvelope<
  "visit.queued",
  {
    queueEntryId: QueueEntryId;
    stationId: StationId;
    /** Ordinal in the station's series. */
    queueNumber: number;
    /** The ticket as issued and announced, e.g. "A-001". */
    queueLabel: string;
    priority: Priority;
    /** Set when this queueing followed a route from another station. */
    fromStationId: StationId | null;
  }
>;

export type VisitCalled = DomainEventEnvelope<
  "visit.called",
  {
    queueEntryId: QueueEntryId;
    stationId: StationId;
    calledBy: UserId;
    /** 1 on the first call, incrementing on each recall. */
    callAttempt: number;
  }
>;

export type VisitServiceStarted = DomainEventEnvelope<
  "visit.service_started",
  {
    queueEntryId: QueueEntryId;
    stationId: StationId;
    servedBy: UserId;
    /** Milliseconds between joining the queue and service starting. */
    waitedMillis: number;
  }
>;

export type VisitSkipped = DomainEventEnvelope<
  "visit.skipped",
  {
    queueEntryId: QueueEntryId;
    stationId: StationId;
    reason: string | null;
  }
>;

export type StageCompleted = DomainEventEnvelope<
  "visit.stage_completed",
  {
    queueEntryId: QueueEntryId;
    stationId: StationId;
    /** Milliseconds between service starting and the stage completing. */
    serviceMillis: number;
    /** Total milliseconds the visit spent attached to this station. */
    stageMillis: number;
  }
>;

export type VisitRouted = DomainEventEnvelope<
  "visit.routed",
  {
    fromStationId: StationId;
    toStationId: StationId;
    reason: string | null;
    /** False when a human overrode the workflow's suggested next stage. */
    followedWorkflow: boolean;
  }
>;

export type VisitCompleted = DomainEventEnvelope<
  "visit.completed",
  {
    /** Milliseconds from visit creation to completion — the headline metric. */
    totalMillis: number;
    stationsVisited: number;
  }
>;

export type VisitCancelled = DomainEventEnvelope<
  "visit.cancelled",
  { reason: string | null }
>;

export type VisitClosed = DomainEventEnvelope<"visit.closed", Record<never, never>>;

export type VisitPriorityChanged = DomainEventEnvelope<
  "visit.priority_changed",
  { from: Priority; to: Priority; reason: string | null }
>;

export type VisitEvent =
  | VisitCreated
  | VisitQueued
  | VisitCalled
  | VisitServiceStarted
  | VisitSkipped
  | StageCompleted
  | VisitRouted
  | VisitCompleted
  | VisitCancelled
  | VisitClosed
  | VisitPriorityChanged;

export type VisitEventType = VisitEvent["type"];
