/**
 * Branded identifier types.
 *
 * These are strings at runtime (zero cost) but distinct at compile time, so the
 * compiler rejects passing a StationId where a VisitId is expected. In a system
 * whose core operation is "move visit X to station Y", that class of mix-up is
 * exactly the one worth making unrepresentable.
 */

declare const brand: unique symbol;

export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type HospitalId = Branded<string, "HospitalId">;
export type BranchId = Branded<string, "BranchId">;
export type UserId = Branded<string, "UserId">;
export type StationId = Branded<string, "StationId">;
export type ServiceId = Branded<string, "ServiceId">;
export type WorkflowId = Branded<string, "WorkflowId">;
export type WorkflowStageId = Branded<string, "WorkflowStageId">;
export type VisitId = Branded<string, "VisitId">;
export type QueueEntryId = Branded<string, "QueueEntryId">;
export type ActivityId = Branded<string, "ActivityId">;

export const HospitalId = (value: string): HospitalId => value as HospitalId;
export const BranchId = (value: string): BranchId => value as BranchId;
export const UserId = (value: string): UserId => value as UserId;
export const StationId = (value: string): StationId => value as StationId;
export const ServiceId = (value: string): ServiceId => value as ServiceId;
export const WorkflowId = (value: string): WorkflowId => value as WorkflowId;
export const WorkflowStageId = (value: string): WorkflowStageId =>
  value as WorkflowStageId;
export const VisitId = (value: string): VisitId => value as VisitId;
export const QueueEntryId = (value: string): QueueEntryId =>
  value as QueueEntryId;
export const ActivityId = (value: string): ActivityId => value as ActivityId;

/**
 * Port for identifier generation. The domain never reaches for `crypto` or a
 * database sequence directly — infrastructure supplies the strategy (UUIDv7 in
 * production, deterministic counters in tests).
 */
export interface IdGenerator {
  next(): string;
}
