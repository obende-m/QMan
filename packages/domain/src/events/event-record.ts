import type { VisitEventType } from "./visit-events.js";
import type { BranchId, HospitalId, UserId } from "../shared/ids.js";

/**
 * Business events as durable records.
 *
 * The distinction that matters: these are not messages that happen to be
 * logged, they are the history of what the hospital did. `VisitCalled` is the
 * fact that a named member of staff called a named patient forward at a
 * recorded time — that is a business record, and it outlives the subscriber
 * that reacted to it.
 *
 * This is deliberately *not* event sourcing. Visits and queue entries are
 * stored as ordinary rows and are the working state; the event log runs
 * alongside them as the narrative. That gives the audit trail, the activity
 * timeline and future analytics everything they need without the operational
 * cost of rebuilding state from a stream on every read.
 */

/**
 * Who a record is for, and therefore which screen it belongs on.
 *
 * Operational and administrative events answer different questions for
 * different people — "when was this patient called" versus "who changed the
 * SLA" — and mixing them produces a feed where neither is findable.
 */
export type ActivityCategory = "operational" | "administrative" | "security";

/** The stored shape of a business event. */
export interface EventRecord {
  readonly id: string;
  /** Monotonic per hospital. Gives the log a total order independent of clocks. */
  readonly sequence: number;
  readonly hospitalId: HospitalId;
  readonly branchId: BranchId;
  readonly category: ActivityCategory;
  /** e.g. "visit.called", "config.station_updated", "auth.signed_in". */
  readonly type: string;
  /** The visit this concerns, when it concerns one. */
  readonly visitId: string | null;
  /**
   * Groups related records so an investigation is one query rather than a
   * reconstruction.
   *
   * For operational events this is the **Journey Code** — a natural correlation
   * key that is already printed on the ticket, spoken at the desk and known to
   * the patient. Someone asking "what happened to QM-8F4K" can be answered
   * without first looking up an internal id.
   *
   * For administrative and security events it is the **session id**, which
   * groups everything one person did in one sitting: signed in, changed three
   * SLAs, signed out.
   */
  readonly correlationId: string | null;
  readonly actorId: UserId | null;
  readonly occurredAt: Date;
  /** When the row was written. Differs from occurredAt on a replay or import. */
  readonly recordedAt: Date;
  /** Event-specific detail. Stored as JSONB. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Pre-rendered, human-readable summary, so the explorer needs no logic. */
  readonly summary: string;
}

/**
 * Administrative and security event types.
 *
 * Named here rather than as free strings so the explorer can filter on a closed
 * set, and so a typo is a compile error rather than a record nobody can find.
 */
export const ADMIN_EVENT_TYPES = [
  "config.station_updated",
  "config.station_added",
  "config.workflow_updated",
  "config.display_board_updated",
  "config.queue_numbering_updated",
  "config.sla_updated",
  "config.privacy_updated",
  "config.ticket_template_updated",
  "config.announcement_updated",
  "config.profile_updated",
] as const;

export const SECURITY_EVENT_TYPES = [
  "auth.signed_in",
  "auth.sign_in_failed",
  "auth.signed_out",
  "auth.account_locked",
  "auth.password_changed",
  "auth.session_terminated",
  "auth.role_changed",
] as const;

export type AdminEventType = (typeof ADMIN_EVENT_TYPES)[number];
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export function categoryOf(type: string): ActivityCategory {
  if ((SECURITY_EVENT_TYPES as readonly string[]).includes(type)) {
    return "security";
  }
  if ((ADMIN_EVENT_TYPES as readonly string[]).includes(type)) {
    return "administrative";
  }
  return "operational";
}

/**
 * A query against the event log.
 *
 * Every field is optional and they combine with AND. The questions this has to
 * answer are concrete — "who called ticket A-023", "when was this patient sent
 * to Laboratory", "who changed this SLA" — and each is a different combination
 * of the same few filters.
 */
export interface EventQuery {
  readonly categories?: readonly ActivityCategory[];
  readonly types?: readonly string[];
  readonly visitId?: string;
  /** Everything related to one journey, or one administrative sitting. */
  readonly correlationId?: string;
  readonly actorId?: UserId;
  readonly branchId?: BranchId;
  readonly from?: Date;
  readonly to?: Date;
  /** Free text, matched against the rendered summary. */
  readonly search?: string;
  readonly limit?: number;
  /** Sequence to page from; results are strictly older than this. */
  readonly before?: number;
}

export const DEFAULT_EVENT_PAGE_SIZE = 50;

/** Applies a query in memory. The SQL repository mirrors this exactly. */
export function matchesQuery(record: EventRecord, query: EventQuery): boolean {
  if (query.categories && !query.categories.includes(record.category)) {
    return false;
  }
  if (query.types && !query.types.includes(record.type)) return false;
  if (query.visitId && record.visitId !== query.visitId) return false;
  if (
    query.correlationId &&
    record.correlationId?.toUpperCase() !== query.correlationId.toUpperCase()
  ) {
    // Case-insensitive: a Journey Code typed from a ticket is a correlation id
    // a human enters, and they will type it in lower case.
    return false;
  }
  if (query.actorId && record.actorId !== query.actorId) return false;
  if (query.branchId && record.branchId !== query.branchId) return false;
  if (query.from && record.occurredAt.getTime() < query.from.getTime()) {
    return false;
  }
  if (query.to && record.occurredAt.getTime() > query.to.getTime()) {
    return false;
  }
  if (query.before !== undefined && record.sequence >= query.before) {
    return false;
  }
  if (query.search) {
    const needle = query.search.trim().toLowerCase();
    if (needle.length > 0 && !record.summary.toLowerCase().includes(needle)) {
      return false;
    }
  }
  return true;
}
