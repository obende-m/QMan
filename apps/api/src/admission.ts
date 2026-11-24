/**
 * Admitting a patient, and moving one between stations.
 *
 * Both operations need the same three things the queue actions do not: a
 * configuration to read numbering from, a ticket allocated without collision,
 * and — for admission — a Journey Code and tracking token that do not already
 * belong to someone.
 *
 * None of the rules live here. The Journey Code alphabet, the queue-number
 * template, the reset period, whether a route is permitted by the workflow: all
 * of that is `@qman/domain`, and this assembles the pieces in the order the
 * aggregate expects them.
 *
 * The browser used to do exactly this, against a configuration it also held.
 * That was the arrangement that made two sources of truth possible — a ticket
 * numbered from one copy of a station's template while the manager's SLA was
 * measured against another.
 */
import {
  generateUniqueJourneyCode,
  issueTicket,
  resetPeriodKey,
  Visit,
  type BranchId,
  type HospitalConfiguration,
  type JourneyCode,
  type Priority,
  type QueueTicket,
  type StationId,
  type UserId,
  type VisitDependencies,
  type WorkflowId,
} from "@qman/domain";
import type { TicketAllocator, VisitRepository } from "@qman/persistence";

export interface AdmissionDependencies {
  readonly visits: VisitRepository;
  readonly allocator: TicketAllocator;
  readonly deps: VisitDependencies;
}

/**
 * Allocates the next ticket for a station.
 *
 * The period key comes from the station's own reset strategy, so a series
 * restarts when the period rolls over rather than when a nightly job
 * remembers to run.
 */
export async function issueTicketFor(
  configuration: HospitalConfiguration,
  allocator: TicketAllocator,
  stationId: StationId,
  journeyCode: JourneyCode,
  issuedAt: Date,
): Promise<QueueTicket> {
  const station = configuration.stations.find((s) => s.id === stationId);
  if (station === undefined) {
    throw new Error(`Station ${stationId} is not configured.`);
  }

  const timeZone = configuration.profile.timezone || undefined;
  const periodKey = resetPeriodKey(station.queueNumber, issuedAt, timeZone);
  const ordinal = await allocator.next(stationId, periodKey);

  return issueTicket(station.queueNumber, {
    ordinal,
    stationCode: station.code,
    journeyCode,
    issuedAt,
    ...(timeZone ? { timeZone } : {}),
  });
}

export interface AdmissionRequest {
  readonly branchId: BranchId;
  readonly workflowId: WorkflowId;
  readonly patient: { name: string; hospitalNumber: string | null; phone: string | null };
  readonly priority?: Priority;
  readonly actorId: UserId;
}

export interface Admission {
  readonly visit: Visit;
  /** Returned once, printed into the ticket's QR code, and never stored raw. */
  readonly trackingToken: string;
}

/**
 * Creates a visit and places it in the first station of its workflow.
 *
 * The Journey Code is checked against open visits in the branch before use, so
 * two patients waiting at the same time never hold the same code — the property
 * that makes it usable at a desk. Codes are reused across days by design: the
 * space is small because it has to be readable aloud, and scoping uniqueness to
 * what is currently open is what keeps it both short and unambiguous.
 */
export async function admit(
  dependencies: AdmissionDependencies,
  configuration: HospitalConfiguration,
  request: AdmissionRequest,
  newTrackingToken: () => string,
  hashToken: (token: string) => string,
): Promise<Admission> {
  const { visits, allocator, deps } = dependencies;

  const workflow = configuration.workflows.find((w) => w.id === request.workflowId);
  if (workflow === undefined) {
    throw new Error(`Workflow ${request.workflowId} is not configured.`);
  }

  const first = [...workflow.stages].sort((a, b) => a.sequence - b.sequence)[0];
  if (first === undefined) {
    throw new Error(`Workflow ${workflow.name} has no stages.`);
  }

  const journeyCode = await generateUniqueJourneyCode(
    (code) => visits.isJourneyCodeTaken(request.branchId, code),
  );

  const visit = Visit.create(
    {
      journeyCode,
      branchId: request.branchId,
      workflowId: request.workflowId,
      patient: request.patient,
      ...(request.priority ? { priority: request.priority } : {}),
    },
    deps,
    { actorId: request.actorId },
  );

  const ticket = await issueTicketFor(
    configuration,
    allocator,
    first.stationId,
    journeyCode,
    deps.clock.now(),
  );

  visit.enqueue(first.stationId, ticket, { actorId: request.actorId });

  const trackingToken = newTrackingToken();
  return { visit, trackingToken };
}

/**
 * Moves a visit to another station, allocating that station's next ticket.
 *
 * Whether the destination is permitted is the aggregate's decision — it knows
 * the workflow and refuses a route the stages do not allow unless the caller
 * holds the permission to leave the workflow. This only supplies the ticket.
 */
export async function ticketForRoute(
  dependencies: AdmissionDependencies,
  configuration: HospitalConfiguration,
  visit: Visit,
  toStationId: StationId,
): Promise<QueueTicket> {
  return issueTicketFor(
    configuration,
    dependencies.allocator,
    toStationId,
    visit.journeyCode,
    dependencies.deps.clock.now(),
  );
}

export type { HospitalConfiguration };
