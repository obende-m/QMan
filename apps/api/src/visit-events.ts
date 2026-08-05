/**
 * Turning a domain event into a stored record.
 *
 * The aggregate emits events describing what happened. The event log stores
 * records, which are the same thing plus the context only the application knows:
 * which hospital, which category, and a summary rendered in words.
 *
 * The summary is rendered here, at write time, rather than by whatever screen
 * later displays it. Two reasons. A record read three years from now must read
 * the same as it did when written, and a renderer that has changed since would
 * quietly rewrite history. And the audit trail must be readable by someone with
 * a SQL prompt and no application — which is exactly the situation during an
 * incident.
 */
import { categoryOf, type UserId, type VisitEvent } from "@qman/domain";
import type { NewEvent } from "@qman/persistence";

export interface EventContext {
  readonly hospitalId: string;
  /** Groups administrative and security records by sitting. */
  readonly sessionId: string | null;
}

/**
 * Ticket and station, never the patient's name.
 *
 * The log is read by more people than the application is — administrators,
 * auditors, whoever is holding the incident. Identifying a case by station and
 * ticket keeps it useful without making the audit trail a second, less guarded
 * copy of the patient list.
 */
function summarise(event: VisitEvent): string {
  const code = event.journeyCode;
  switch (event.type) {
    case "visit.created":
      return `Visit ${code} created`;
    case "visit.queued":
      return `${code} joined the queue as ${event.payload.queueLabel}`;
    case "visit.called":
      return event.payload.callAttempt > 1
        ? `${code} recalled (attempt ${event.payload.callAttempt})`
        : `${code} called`;
    case "visit.service_started":
      return `Service started for ${code}`;
    case "visit.skipped":
      return `${code} skipped and returned to the queue`;
    case "visit.stage_completed":
      return `${code} completed a stage`;
    case "visit.routed":
      return event.payload.followedWorkflow === false
        ? `${code} routed outside the workflow`
        : `${code} routed onward`;
    case "visit.completed":
      return `${code} completed`;
    case "visit.cancelled":
      return `${code} cancelled`;
    case "visit.closed":
      return `${code} closed`;
    case "visit.priority_changed":
      return `${code} priority changed to ${event.payload.to}`;
    default:
      // A new event type must still produce a record. An unreadable summary is
      // recoverable; a missing audit entry is not.
      return `${code}: ${(event as VisitEvent).type}`;
  }
}

export function toNewEvent(event: VisitEvent, context: EventContext): NewEvent {
  const category = categoryOf(event.type);
  return {
    hospitalId: context.hospitalId as NewEvent["hospitalId"],
    branchId: event.branchId,
    category,
    type: event.type,
    visitId: event.visitId,
    // Operational records correlate by Journey Code, which is printed on the
    // ticket and known to the patient. Administrative and security records
    // correlate by session, grouping everything one person did in one sitting.
    correlationId: category === "operational" ? event.journeyCode : context.sessionId,
    actorId: event.actorId as UserId | null,
    occurredAt: event.occurredAt,
    payload: event.payload as Readonly<Record<string, unknown>>,
    summary: summarise(event),
  };
}
