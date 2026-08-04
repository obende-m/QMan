import type { BranchId, UserId, VisitId } from "../shared/ids.js";
import type { JourneyCode } from "../journey/journey-code.js";

/**
 * Every state change publishes an event. The SAD's real-time fan-out, the audit
 * trail, the notification engine and the analytics module are all consumers of
 * this one stream — which is what lets a premium analytics module ship without
 * touching visit management.
 */
export interface DomainEventEnvelope<TType extends string, TPayload> {
  readonly type: TType;
  readonly visitId: VisitId;
  readonly branchId: BranchId;
  /**
   * The visit's Journey Code, carried on every event about it.
   *
   * Correlation travels *with* the event rather than being reconstructed by
   * subscribers. A subscriber that had to remember the code from
   * `visit.created` would lose it on restart, on a late subscription, or when
   * events arrive over a socket from another process — and correlation that is
   * only sometimes present is correlation nobody can rely on.
   */
  readonly journeyCode: JourneyCode;
  /** The staff member who caused this, if any. System actions carry null. */
  readonly actorId: UserId | null;
  readonly occurredAt: Date;
  readonly payload: TPayload;
}

/**
 * Distributes `Omit` across a union, so each member keeps its own payload type.
 * A plain `Omit<Union, K>` would collapse the union into one wide object.
 */
export type WithoutEnvelope<T> = T extends unknown
  ? Omit<T, "journeyCode">
  : never;

