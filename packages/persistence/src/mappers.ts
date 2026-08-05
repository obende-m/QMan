import {
  BranchId,
  QueueEntryId,
  StationId,
  UserId,
  VisitId,
  Visit,
  WorkflowId,
  WorkflowStageId,
  categoryOf,
  isJourneyCode,
  PERMISSIONS,
  type Permission,
  type ActivityCategory,
  type EventRecord,
  type HospitalId,
  type JourneyCode,
  type Priority,
  type QueueEntry,
  type QueueEntryStatus,
  type QueueNumberConfig,
  type QueueResetStrategy,
  type Session,
  type SessionEndReason,
  type StationConfig,
  type UserAccount,
  type VisitDependencies,
  type VisitState,
  type VisitStatus,
  type Workflow,
  type WorkflowStage,
} from "@qman/domain";
import type {
  EventRow,
  QueueEntryRow,
  SessionRow,
  StationRow,
  UserRow,
  VisitRow,
  WorkflowRow,
  WorkflowStageRow,
} from "./rows.js";

/**
 * Mapping between database rows and domain objects.
 *
 * Deliberately hand-written and deliberately total. An ORM would infer most of
 * this, but it would also silently accept a row whose `status` column holds a
 * value the state machine has never heard of — and the failure would surface as
 * a visit that cannot be acted on, in production, with a patient waiting.
 *
 * Every enum-shaped column is therefore validated on the way in, and a bad
 * value throws immediately with the row's id, where it is cheap to diagnose.
 */

export class MappingError extends Error {
  constructor(
    readonly table: string,
    readonly rowId: string,
    readonly column: string,
    readonly value: unknown,
  ) {
    super(
      `${table}.${column} holds an unexpected value ${JSON.stringify(value)} (row ${rowId}). ` +
        `The database and the domain disagree — this is a migration or a manual edit.`,
    );
    this.name = "MappingError";
  }
}

function oneOf<T extends string>(
  allowed: readonly T[],
  value: string,
  table: string,
  rowId: string,
  column: string,
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new MappingError(table, rowId, column, value);
}

const VISIT_STATUSES = [
  "created",
  "queued",
  "called",
  "in_progress",
  "completed",
  "cancelled",
  "closed",
] as const;

const QUEUE_STATUSES = [
  "waiting",
  "called",
  "in_progress",
  "skipped",
  "completed",
  "cancelled",
] as const;

const PRIORITIES = ["emergency", "high", "vip", "normal"] as const;

const RESET_STRATEGIES = [
  "daily",
  "weekly",
  "monthly",
  "never",
  "manual",
] as const;

const CATEGORIES = ["operational", "administrative", "security"] as const;

const END_REASONS = [
  "signed_out",
  "expired",
  "terminated_by_admin",
  "password_changed",
] as const;

// ───────────────────────────────────────────────────────────────── visits

export function toQueueEntry(row: QueueEntryRow): QueueEntry {
  return {
    id: QueueEntryId(row.id),
    stationId: StationId(row.station_id),
    queueNumber: row.queue_number,
    queueLabel: row.queue_label,
    queuePeriod: row.queue_period,
    status: oneOf<QueueEntryStatus>(
      QUEUE_STATUSES,
      row.status,
      "queue_entries",
      row.id,
      "status",
    ),
    assignedUserId: row.assigned_user_id ? UserId(row.assigned_user_id) : null,
    queuedAt: row.queued_at,
    calledAt: row.called_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    callAttempts: row.call_attempts,
    skipped: row.skipped,
    skipReason: row.skip_reason,
  };
}

export function fromQueueEntry(
  entry: QueueEntry,
  visitId: VisitId,
  sequence: number,
): QueueEntryRow {
  return {
    id: entry.id,
    visit_id: visitId,
    station_id: entry.stationId,
    queue_number: entry.queueNumber,
    queue_label: entry.queueLabel,
    queue_period: entry.queuePeriod,
    status: entry.status,
    assigned_user_id: entry.assignedUserId,
    queued_at: entry.queuedAt,
    called_at: entry.calledAt,
    started_at: entry.startedAt,
    completed_at: entry.completedAt,
    call_attempts: entry.callAttempts,
    skipped: entry.skipped,
    skip_reason: entry.skipReason,
    sequence,
  };
}

export function toVisitState(
  row: VisitRow,
  entries: readonly QueueEntryRow[],
): VisitState {
  if (!isJourneyCode(row.journey_code)) {
    throw new MappingError("visits", row.id, "journey_code", row.journey_code);
  }

  // Ordered by the explicit sequence column, never by timestamp: two legs can
  // share a millisecond and the journey would then read out of order.
  const ordered = [...entries].sort((a, b) => a.sequence - b.sequence);

  return {
    id: VisitId(row.id),
    journeyCode: row.journey_code as JourneyCode,
    branchId: BranchId(row.branch_id),
    workflowId: WorkflowId(row.workflow_id),
    patient: {
      name: row.patient_name,
      hospitalNumber: row.hospital_number,
      phone: row.phone,
    },
    status: oneOf<VisitStatus>(
      VISIT_STATUSES,
      row.status,
      "visits",
      row.id,
      "status",
    ),
    priority: oneOf<Priority>(
      PRIORITIES,
      row.priority,
      "visits",
      row.id,
      "priority",
    ),
    currentQueueEntryId: row.current_queue_entry_id
      ? QueueEntryId(row.current_queue_entry_id)
      : null,
    queueEntries: ordered.map(toQueueEntry),
    createdAt: row.created_at,
    completedAt: row.completed_at,
    closedAt: row.closed_at,
  };
}

export function toVisit(
  row: VisitRow,
  entries: readonly QueueEntryRow[],
  deps: VisitDependencies,
): Visit {
  return Visit.rehydrate(toVisitState(row, entries), deps);
}

export function fromVisit(visit: Visit): {
  visit: VisitRow;
  entries: QueueEntryRow[];
} {
  const state = visit.toState();

  return {
    visit: {
      id: state.id,
      branch_id: state.branchId,
      workflow_id: state.workflowId,
      journey_code: state.journeyCode,
      patient_name: state.patient.name,
      hospital_number: state.patient.hospitalNumber,
      phone: state.patient.phone,
      status: state.status,
      priority: state.priority,
      current_queue_entry_id: state.currentQueueEntryId,
      created_at: state.createdAt,
      completed_at: state.completedAt,
      closed_at: state.closedAt,
    },
    entries: state.queueEntries.map((entry, index) =>
      fromQueueEntry(entry, state.id, index + 1),
    ),
  };
}

// ───────────────────────────────────────────────────────────────── events

export function toEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    // bigserial arrives as a string from most Postgres drivers, because it can
    // exceed Number.MAX_SAFE_INTEGER. Parsed here so callers see a number.
    sequence:
      typeof row.sequence === "string" ? Number(row.sequence) : row.sequence,
    hospitalId: row.hospital_id as HospitalId,
    branchId: BranchId(row.branch_id),
    category: oneOf<ActivityCategory>(
      CATEGORIES,
      row.category,
      "events",
      row.id,
      "category",
    ),
    type: row.type,
    visitId: row.visit_id,
    correlationId: row.correlation_id,
    actorId: row.actor_id ? UserId(row.actor_id) : null,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    payload: row.payload,
    summary: row.summary,
  };
}

export function fromEventRecord(
  record: Omit<EventRecord, "id" | "sequence" | "recordedAt">,
): Omit<EventRow, "id" | "sequence" | "recorded_at"> {
  return {
    hospital_id: record.hospitalId,
    branch_id: record.branchId,
    // Derived rather than trusted from the caller: a record filed under the
    // wrong category is invisible on the screen that should show it.
    category: categoryOf(record.type),
    type: record.type,
    visit_id: record.visitId,
    correlation_id: record.correlationId,
    actor_id: record.actorId,
    occurred_at: record.occurredAt,
    payload: record.payload as Record<string, unknown>,
    summary: record.summary,
  };
}

// ─────────────────────────────────────────────────────────── configuration

export function toStationConfig(row: StationRow): StationConfig {
  const numbering: QueueNumberConfig = {
    template: row.queue_template,
    reset: oneOf<QueueResetStrategy>(
      RESET_STRATEGIES,
      row.queue_reset,
      "stations",
      row.id,
      "queue_reset",
    ),
    ...(row.queue_manual_epoch === null
      ? {}
      : { manualEpoch: row.queue_manual_epoch }),
  };

  return {
    id: StationId(row.id),
    name: row.name,
    code: row.code,
    room: row.room,
    staffing: row.staffing,
    serviceEstimateMillis: row.service_estimate_ms,
    sla: {
      targetWaitMillis: row.sla_target_wait_ms,
      saturationPoint: row.sla_saturation_point,
    },
    queueNumber: numbering,
    isPublic: row.is_public,
    enabled: row.enabled,
  };
}

export function toWorkflow(
  row: WorkflowRow,
  stages: readonly WorkflowStageRow[],
): Workflow {
  return {
    id: WorkflowId(row.id),
    branchId: BranchId(row.branch_id),
    name: row.name,
    isDefault: row.is_default,
    stages: [...stages]
      .sort((a, b) => a.sequence - b.sequence)
      .map(
        (stage): WorkflowStage => ({
          id: WorkflowStageId(stage.id),
          stationId: StationId(stage.station_id),
          sequence: stage.sequence,
          isRequired: stage.is_required,
          allowSkip: stage.allow_skip,
          allowRepeat: stage.allow_repeat,
          branchesTo: stage.branches_to.map(StationId),
        }),
      ),
  };
}

// ─────────────────────────────────────────────────────────────── accounts

/**
 * An account together with the secret material used to verify it.
 *
 * Kept apart from `UserAccount` on purpose. `UserAccount` is what the rest of
 * the application sees and is safe to hand to a route, a log line or a
 * response body; the hash and salt exist only inside the authentication step
 * and are never carried further. Two types make that boundary something the
 * compiler enforces rather than something a reviewer has to notice.
 */
export interface StoredAccount {
  readonly account: UserAccount;
  /** The tenant this account belongs to. Never inferred from the request. */
  readonly hospitalId: string;
  readonly roleKey: string;
  readonly permissions: readonly Permission[];
  readonly passwordHash: string | null;
  readonly passwordSalt: string | null;
}

/**
 * Permissions the domain does not recognise are dropped, not rejected.
 *
 * A role granting an unknown permission means the database was configured by a
 * newer build than the one reading it. Dropping the unknown entry degrades that
 * user's access; failing the lookup would lock every holder of the role out of
 * a running hospital, which is far worse than one missing button.
 */
function knownPermissions(values: readonly string[]): Permission[] {
  return values.filter((value): value is Permission => value in PERMISSIONS);
}

export function toStoredAccount(row: UserRow): StoredAccount {
  return {
    roleKey: row.role_key,
    permissions: knownPermissions(row.permissions),
    account: {
      id: UserId(row.id),
      displayName: row.display_name,
      username: row.username,
      roleId: row.role_id,
      branchIds: row.branch_ids.map((id) => BranchId(id)),
      providerId: row.provider_id,
      enabled: row.enabled,
    },
    hospitalId: row.hospital_id,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
  };
}

// ─────────────────────────────────────────────────────────────── sessions

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: UserId(row.user_id),
    branchId: row.branch_id ? BranchId(row.branch_id) : null,
    providerId: row.provider_id,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    endedAt: row.ended_at,
    endReason: row.end_reason
      ? oneOf<SessionEndReason>(
          END_REASONS,
          row.end_reason,
          "sessions",
          row.id,
          "end_reason",
        )
      : null,
    device: row.device,
    userAgent: row.user_agent,
  };
}

export function fromSession(session: Session): SessionRow {
  return {
    id: session.id,
    user_id: session.userId,
    branch_id: session.branchId,
    provider_id: session.providerId,
    device: session.device,
    user_agent: session.userAgent,
    started_at: session.startedAt,
    last_active_at: session.lastActiveAt,
    ended_at: session.endedAt,
    end_reason: session.endReason,
  };
}
