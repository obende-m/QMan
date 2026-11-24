/**
 * The queue endpoints.
 *
 * Named for what the hospital does. `POST /api/visits/:id/call` is an action a
 * receptionist recognises; `PATCH /api/queue_entries/:id` with a status field
 * would be the same write with the meaning removed — and with the state
 * machine's rules pushed back out to every caller that has to know which field
 * to set and when.
 *
 * Each handler does the same four things in the same order: load the aggregate,
 * ask it to do the thing, persist the result with its events, publish. The
 * aggregate decides whether the action is legal; this layer never inspects
 * status to decide for itself, because the transition table is the one place
 * that knowledge is allowed to live.
 *
 * Three rules apply to every response here.
 *
 * - **Identity follows `visit.view_identity`.** A visit is serialised for the
 *   caller, not once for everyone: a manager's dashboard receives the same
 *   aggregate with the patient emptied out.
 * - **Branch-pinned staff see their branch.** The tenant is the boundary; the
 *   branch is a narrowing inside it that is enforced here, on reads as well as
 *   writes.
 * - **The browser states intentions, never facts.** Whether a route follows the
 *   workflow is decided from the workflow, here, and not taken from the body.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  DEFAULT_EVENT_PAGE_SIZE,
  DomainError,
  InvariantViolationError,
  ValidationError,
  BranchId,
  StationId,
  UserId,
  VisitId,
  isPriority,
  resolveRoute,
  type ActivityCategory,
  type EventQuery,
  type HospitalConfiguration,
  type Permission,
  type QueueTicket,
  visitToWire,
  type Visit,
  type WorkflowId,
} from "@qman/domain";
import {
  ConcurrentModificationError,
  type ConfigurationRepository,
  type EventRepository,
  type VisitRepository,
} from "@qman/persistence";
import { admit, ticketForRoute, type AdmissionDependencies } from "./admission.js";
import { requirePermission, tenantOf, type GuardDependencies } from "./authorization.js";
import { describeEvent, type EventStream } from "./stream.js";
import { toNewEvent } from "./visit-events.js";
import type { Logger } from "./logging.js";
import { guard, record, type IdempotencyDependencies } from "./idempotency.js";
import { isUuid, optionalText } from "./identifiers.js";
import { V1 } from "./version.js";

/**
 * What admission and routing need beyond the queue actions: a configuration to
 * number tickets from, an allocator, and the token generator for a new visit.
 */
export interface AdmissionSupport extends AdmissionDependencies {
  readonly configuration: ConfigurationRepository;
  readonly newTrackingToken: () => string;
  readonly hashToken: (token: string) => string;
}

export interface QueueRouteDependencies {
  readonly guards: GuardDependencies;
  readonly visits: VisitRepository;
  readonly events: EventRepository;
  readonly stream: EventStream;
  readonly logger: Logger;
  /** Absent in tests that are not about retries; every deployment has it. */
  readonly idempotency?: IdempotencyDependencies;
  /** Absent in suites that only exercise queue transitions. */
  readonly admission?: AdmissionSupport;
}

/** Limits on the patient reference, which is a reference and not a record. */
const PATIENT_NAME_MAX = 200;
const HOSPITAL_NUMBER_MAX = 64;
const PHONE_MAX = 32;

/** Categories that are the audit log rather than the activity timeline. */
const AUDIT_CATEGORIES: readonly ActivityCategory[] = ["administrative", "security"];
const AUDIT_PERMISSIONS: readonly Permission[] = ["admin.users", "admin.settings"];

function holds(request: FastifyRequest, permission: Permission): boolean {
  return request.authenticated!.user.permissions.includes(permission);
}

function mayViewIdentity(request: FastifyRequest): boolean {
  return holds(request, "visit.view_identity");
}

/**
 * The branch a caller is restricted to, or null for organization-wide staff.
 *
 * The session's branch is the one chosen at sign-in, from those the account is
 * assigned to, so it is already a narrowing the server granted.
 */
function pinnedBranch(request: FastifyRequest): string | null {
  return request.authenticated!.session.branchId;
}

/**
 * What a queue entry looks like to a client.
 *
 * Assembled field by field. Serialising the aggregate would export whatever it
 * happens to hold, so a field added to the domain later — a clinical note, a
 * diagnosis code — would begin reaching display boards without anyone deciding
 * that it should.
 */
export function describeVisit(visit: Visit, includeIdentity: boolean): Record<string, unknown> {
  const entry = visit.currentEntry;
  return {
    /**
     * The aggregate's own state, so a staff surface can rehydrate the visit and
     * call the same domain projections the server would — queue position,
     * estimated wait, station health. Identity is included only for a caller
     * holding `visit.view_identity`.
     *
     * Staff only. The display board and patient tracker have their own
     * projections, which carry neither the patient nor the Journey Code.
     */
    state: visitToWire(visit, { includeIdentity }),
    id: visit.id,
    journeyCode: visit.journeyCode,
    branchId: visit.branchId,
    workflowId: visit.workflowId,
    status: visit.status,
    priority: visit.priority,
    stationId: visit.currentStationId,
    stationsVisited: visit.stationsVisited,
    createdAt: visit.createdAt.toISOString(),
    completedAt: visit.completedAt?.toISOString() ?? null,
    currentEntry: entry
      ? {
          id: entry.id,
          stationId: entry.stationId,
          queueNumber: entry.queueNumber,
          queueLabel: entry.queueLabel,
          status: entry.status,
          assignedUserId: entry.assignedUserId,
          queuedAt: entry.queuedAt.toISOString(),
          calledAt: entry.calledAt?.toISOString() ?? null,
          startedAt: entry.startedAt?.toISOString() ?? null,
          callAttempts: entry.callAttempts,
        }
      : null,
  };
}

/**
 * A refusal raised while preparing a transition, with the status it deserves.
 *
 * Preparation can fail for reasons that are neither a fault nor a state
 * conflict — a destination that does not exist, a route the caller is not
 * permitted to take — and those must not be reported as either.
 */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body["error"] ?? "Refused"));
  }
}

/** The status a domain refusal deserves. */
function statusForDomainError(error: DomainError): number {
  if (error instanceof ValidationError) return 422;
  // An illegal transition and a broken invariant both mean the visit is not in
  // a state where the action makes sense — usually because someone acted first.
  return 409;
}

/**
 * Publishes the records a save just committed.
 *
 * Only after the write has landed. A subscriber that acted on an event for a
 * change still in flight would be reacting to something that might yet roll
 * back. The stream is handed the record, never a rendered payload: it renders
 * one per audience, so a board cannot receive the staff projection.
 */
function publish(
  deps: QueueRouteDependencies,
  visit: Visit,
  records: ReturnType<typeof toNewEvent>[],
): void {
  for (const recorded of records) {
    deps.stream.publish({
      ...recorded,
      id: `${visit.id}-${recorded.occurredAt.getTime()}-${recorded.type}`,
      sequence: 0,
      recordedAt: recorded.occurredAt,
    });
  }
}

/**
 * Runs one aggregate action and persists what it produced.
 *
 * Domain refusals become 409 or 422, not 500. The request was well-formed and
 * the caller was entitled to make it; the visit was simply not in a state where
 * it made sense — usually because someone else acted first. "Conflict" is what
 * that is, and the distinction matters to the receptionist, who needs to know
 * their screen is stale rather than that they did something wrong.
 */
async function act<TPrepared = undefined>(
  deps: QueueRouteDependencies,
  request: FastifyRequest,
  reply: FastifyReply,
  apply: (visit: Visit, actor: UserId, prepared: TPrepared) => void,
  /**
   * Anything the transition needs that must be fetched first — a ticket, for
   * routing. Runs after the visit is loaded and before the aggregate acts, so
   * the value belongs to this request rather than to shared state.
   */
  prepare?: (visit: Visit) => Promise<TPrepared>,
): Promise<void> {
  const { id } = request.params as { id: string };
  const authenticated = request.authenticated!;

  if (!isUuid(id)) {
    void reply.status(404).send({ error: "No such visit." });
    return;
  }

  /**
   * A retry is resolved before any work happens. Doing it afterwards would
   * mean the second call had already advanced the attempt counter by the time
   * anyone noticed it was a duplicate.
   */
  const guarded = deps.idempotency
    ? await guard(deps.idempotency, request, reply)
    : ({ proceed: true, key: null } as const);
  if (!guarded.proceed) return;

  const respond = async (status: number, payload: unknown): Promise<void> => {
    if (deps.idempotency) {
      await record(deps.idempotency, request, guarded.key, status, payload);
    }
    void reply.status(status).send(payload);
  };

  // Loaded within the caller's organization, which is the ownership check: the
  // repository refuses to return another organization's visit at all.
  const visit = await deps.visits.find(tenantOf(request), VisitId(id));

  if (visit === null) {
    // The same answer for "does not exist" and "belongs to someone else".
    // Distinguishing them tells a caller probing identifiers which ones are
    // real elsewhere.
    await respond(404, { error: "No such visit." });
    return;
  }

  // A narrowing within the organization, not the tenant boundary: staff pinned
  // to one branch do not act on another branch's patients.
  const branch = pinnedBranch(request);
  if (branch !== null && visit.branchId !== branch) {
    await respond(403, { error: "That visit is in another branch." });
    return;
  }

  try {
    const prepared = (prepare ? await prepare(visit) : undefined) as TPrepared;
    apply(visit, authenticated.user.account.id, prepared);
  } catch (error) {
    // Events recorded before a throw are discarded with it: the aggregate
    // rejected the action, so nothing happened worth publishing.
    visit.pullEvents();
    if (error instanceof Refusal) {
      await respond(error.status, error.body);
      return;
    }
    if (error instanceof DomainError) {
      await respond(statusForDomainError(error), { error: error.message, code: error.code });
      return;
    }
    if (deps.idempotency && guarded.key !== null) {
      // The claim must not outlive a failure, or the retry this exists to
      // support would be answered with a stored error instead of running.
      await record(deps.idempotency, request, guarded.key, 500, null);
    }
    throw error;
  }

  const records = visit.pullEvents().map((event) =>
    toNewEvent(event, {
      hospitalId: tenantOf(request),
      sessionId: authenticated.session.id,
    }),
  );

  try {
    await deps.visits.save(visit, records);
  } catch (error) {
    if (error instanceof ConcurrentModificationError) {
      deps.logger.info("concurrent visit change refused", {
        requestId: request.requestId,
        hospitalId: tenantOf(request),
        visitId: visit.id,
      });
      await respond(409, {
        error: "Someone else updated this patient a moment ago. Refresh and try again.",
        code: error.code,
      });
      return;
    }
    if (deps.idempotency && guarded.key !== null) {
      await record(deps.idempotency, request, guarded.key, 500, null);
    }
    throw error;
  }

  publish(deps, visit, records);
  await respond(200, { visit: describeVisit(visit, mayViewIdentity(request)) });
}

/**
 * Decides, on the server, where a visit may be routed.
 *
 * The workflow is the visit's own, not the hospital's default: a patient
 * admitted on the antenatal pathway follows the antenatal pathway even if the
 * general one has since become the default. The client's opinion about whether
 * the route follows the workflow is not consulted at all; it used to be, which
 * let any holder of `queue.route` send a patient anywhere and have the audit
 * trail record it as an ordinary step.
 */
function decideRoute(
  configuration: HospitalConfiguration,
  visit: Visit,
  destination: string,
  mayLeaveWorkflow: boolean,
): { toStationId: StationId; followedWorkflow: boolean } {
  const station = configuration.stations.find((s) => s.id === destination);
  if (station === undefined) {
    throw new Refusal(422, { error: "That station does not exist." });
  }
  if (!station.enabled) {
    throw new Refusal(422, { error: `${station.name} is not accepting patients.` });
  }

  const workflow = configuration.workflows.find((w) => w.id === visit.workflowId);
  if (workflow === undefined) {
    // The visit's workflow has gone. Any route is now an override.
    if (!mayLeaveWorkflow) {
      throw new Refusal(403, {
        error: "This visit's workflow no longer exists; routing it needs permission to leave the workflow.",
        permission: "queue.route_off_workflow",
      });
    }
    return { toStationId: StationId(destination), followedWorkflow: false };
  }

  try {
    const decision = resolveRoute({
      workflow,
      visit,
      requestedStationId: StationId(destination),
      allowOffWorkflow: mayLeaveWorkflow,
    });
    if (decision.kind !== "route") {
      throw new Refusal(409, { error: "That visit has reached the end of its workflow." });
    }
    return { toStationId: decision.toStationId, followedWorkflow: decision.followedWorkflow };
  } catch (error) {
    if (error instanceof InvariantViolationError && error.code === "ROUTE_NOT_PERMITTED") {
      throw new Refusal(403, {
        error: "You do not have permission to route outside the workflow.",
        permission: "queue.route_off_workflow",
      });
    }
    throw error;
  }
}

export function registerQueueRoutes(app: FastifyInstance, deps: QueueRouteDependencies): void {
  const guarded = (permission: Permission) => ({
    preHandler: requirePermission(deps.guards, permission),
  });

  /**
   * Admits a patient.
   *
   * The one endpoint that creates state rather than moving it, and the one that
   * needs the configuration: a ticket is numbered from the station's own
   * template, and the first stage of the workflow decides where the patient
   * starts.
   *
   * **A retry admits nobody twice.** The idempotency record holds only the new
   * visit's id. A replay finds that visit, mints a fresh tracking token — the
   * only copy of the first was in the response that never arrived — and answers
   * as the first request would have. No credential is ever stored.
   */
  app.post(`${V1}/visits`, guarded("visit.create"), async (request, reply) => {
    const admission = deps.admission;
    if (admission === undefined) {
      return reply.status(503).send({ error: "Admission is not available." });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;

    // ---------------------------------------------------------- validation
    // All of it before anything is claimed or written, so a malformed request
    // leaves no trace but its log line.
    const name = typeof body["patientName"] === "string" ? body["patientName"].trim() : "";
    if (name === "") {
      return reply.status(400).send({ error: "A visit needs a patient name." });
    }
    if (name.length > PATIENT_NAME_MAX) {
      return reply.status(422).send({ error: "That patient name is too long." });
    }
    const hospitalNumber = optionalText(body["hospitalNumber"], HOSPITAL_NUMBER_MAX);
    if (!hospitalNumber.ok) {
      return reply.status(422).send({ error: "That hospital number is not valid." });
    }
    const phone = optionalText(body["phone"], PHONE_MAX);
    if (!phone.ok) {
      return reply.status(422).send({ error: "That phone number is not valid." });
    }

    const requestedPriority = body["priority"];
    if (requestedPriority !== undefined && requestedPriority !== null && !isPriority(requestedPriority)) {
      return reply.status(422).send({
        error: "Priority must be one of emergency, high, vip or normal.",
      });
    }
    const priority = isPriority(requestedPriority) ? requestedPriority : "normal";
    // Raising a patient above the ordinary queue is the escalation permission,
    // whether it happens at the desk or later.
    if (priority !== "normal" && !holds(request, "visit.escalate")) {
      return reply.status(403).send({
        error: "You do not have permission to set a priority.",
        permission: "visit.escalate",
      });
    }

    if (body["workflowId"] !== undefined && typeof body["workflowId"] !== "string") {
      return reply.status(422).send({ error: "That workflow is not valid." });
    }

    const authenticated = request.authenticated!;
    const hospitalId = tenantOf(request);
    const configuration = await admission.configuration.load(hospitalId);
    if (configuration === null) {
      return reply.status(500).send({ error: "Configuration unavailable." });
    }

    const branchId = (authenticated.session.branchId ??
      configuration.branches.find((b) => b.isDefault)?.id ??
      configuration.branches[0]?.id) as BranchId | undefined;
    if (branchId === undefined) {
      return reply.status(422).send({ error: "This hospital has no branches." });
    }

    const workflow =
      typeof body["workflowId"] === "string"
        ? configuration.workflows.find((w) => w.id === body["workflowId"])
        : (configuration.workflows.find((w) => w.isDefault) ?? configuration.workflows[0]);
    if (workflow === undefined) {
      return reply.status(422).send({
        error:
          typeof body["workflowId"] === "string"
            ? "That workflow does not exist."
            : "This hospital has no workflow to admit into.",
      });
    }
    const first = [...workflow.stages].sort((a, b) => a.sequence - b.sequence)[0];
    const firstStation = configuration.stations.find((s) => s.id === first?.stationId);
    if (first === undefined || firstStation === undefined || !firstStation.enabled) {
      return reply.status(422).send({
        error: `"${workflow.name}" cannot admit patients: its first station is missing or disabled.`,
      });
    }

    // ---------------------------------------------------------- idempotency
    const idempotency = deps.idempotency;
    const claim = idempotency
      ? await guard(idempotency, request, reply, {
          onReplay: async (statusCode, stored) => {
            const visitId = (stored as { visitId?: unknown } | null)?.visitId;
            const visit = isUuid(visitId)
              ? await deps.visits.find(hospitalId, VisitId(visitId))
              : null;
            const token = admission.newTrackingToken();
            const reissued =
              visit !== null &&
              (await deps.visits.reissueTrackingToken(
                hospitalId,
                visit.id,
                admission.hashToken(token),
              ));
            if (visit === null || !reissued) {
              // Admitted, then closed or removed before the retry arrived.
              // The patient exists; their tracking link cannot be recovered.
              void reply.status(409).send({
                error: "That admission was already recorded and can no longer be re-sent.",
              });
              return;
            }
            void reply.status(statusCode).send({
              visit: describeVisit(visit, mayViewIdentity(request)),
              trackingToken: token,
            });
          },
        })
      : ({ proceed: true, key: null } as const);
    if (!claim.proceed) return;

    const release = async (): Promise<void> => {
      if (idempotency) await record(idempotency, request, claim.key, 500, null);
    };

    let admitted;
    try {
      admitted = await admit(
        admission,
        configuration,
        {
          branchId,
          workflowId: workflow.id as WorkflowId,
          patient: { name, hospitalNumber: hospitalNumber.value, phone: phone.value },
          priority,
          actorId: authenticated.user.account.id,
        },
        admission.newTrackingToken,
        admission.hashToken,
      );
    } catch (error) {
      await release();
      if (error instanceof DomainError) {
        return reply
          .status(statusForDomainError(error))
          .send({ error: error.message, code: error.code });
      }
      throw error;
    }

    const records = admitted.visit.pullEvents().map((event) =>
      toNewEvent(event, { hospitalId, sessionId: authenticated.session.id }),
    );

    try {
      await deps.visits.save(admitted.visit, records, {
        trackingTokenHash: admission.hashToken(admitted.trackingToken),
      });
    } catch (error) {
      await release();
      throw error;
    }

    publish(deps, admitted.visit, records);

    // What a retry is answered from: the id, nothing else.
    if (idempotency) {
      await record(idempotency, request, claim.key, 201, { visitId: admitted.visit.id });
    }

    // The token is returned exactly once, to be printed into the QR code. Only
    // its hash is stored.
    return reply.status(201).send({
      visit: describeVisit(admitted.visit, mayViewIdentity(request)),
      trackingToken: admitted.trackingToken,
    });
  });

  /**
   * Routes a visit onward.
   *
   * Leaving the workflow is a separate permission from routing within it,
   * because sending a patient somewhere the workflow does not provide for is a
   * deliberate override rather than an ordinary step. Which one this is, is
   * decided here from the visit's workflow.
   */
  app.post(`${V1}/visits/:id/route`, guarded("queue.route"), async (request, reply) => {
    const admission = deps.admission;
    if (admission === undefined) {
      return reply.status(503).send({ error: "Routing is not available." });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const toStationId = typeof body["stationId"] === "string" ? body["stationId"] : "";
    if (!isUuid(toStationId)) {
      return reply.status(400).send({ error: "A destination station is required." });
    }

    const configuration = await admission.configuration.load(tenantOf(request));
    if (configuration === null) {
      return reply.status(500).send({ error: "Configuration unavailable." });
    }

    const mayLeaveWorkflow = holds(request, "queue.route_off_workflow");

    await act<{ ticket: QueueTicket; followedWorkflow: boolean; toStationId: StationId }>(
      deps,
      request,
      reply,
      (visit, actor, prepared) => {
        visit.routeTo(prepared.toStationId, prepared.ticket, {
          actorId: actor,
          followedWorkflow: prepared.followedWorkflow,
        });
      },
      // The decision comes first, and the ticket only once the route is known
      // to be allowed — a refused route must not consume a ticket number.
      async (visit) => {
        const decision = decideRoute(configuration, visit, toStationId, mayLeaveWorkflow);
        const ticket = await ticketForRoute(admission, configuration, visit, decision.toStationId);
        return { ...decision, ticket };
      },
    );
  });

  app.get(`${V1}/stations/:stationId/queue`, guarded("queue.call"), async (request, reply) => {
    const { stationId } = request.params as { stationId: string };
    if (!isUuid(stationId)) return reply.status(404).send({ error: "No such station." });

    const branch = pinnedBranch(request);
    const visits = (await deps.visits.openAtStation(tenantOf(request), StationId(stationId)))
      .filter((visit) => branch === null || visit.branchId === branch);
    const identity = mayViewIdentity(request);
    return reply.status(200).send({ visits: visits.map((v) => describeVisit(v, identity)) });
  });

  app.get(`${V1}/branches/:branchId/visits`, guarded("reports.view"), async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    if (!isUuid(branchId)) return reply.status(404).send({ error: "No such branch." });

    const branch = pinnedBranch(request);
    if (branch !== null && branch !== branchId) {
      return reply.status(403).send({ error: "That is another branch." });
    }

    const visits = await deps.visits.activeInBranch(tenantOf(request), BranchId(branchId));
    const identity = mayViewIdentity(request);
    return reply.status(200).send({ visits: visits.map((v) => describeVisit(v, identity)) });
  });

  app.post(`${V1}/visits/:id/call`, guarded("queue.call"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.call(actor, { actorId: actor });
    });
  });

  /**
   * Recall is its own transition: only a patient already called can be
   * recalled, and only a patient not yet called can be called. Two endpoints
   * because they are two intentions carrying two permissions — a role may be
   * allowed to call patients without being allowed to keep recalling one — and
   * a Call that the server quietly turned into a recall would bypass the second.
   */
  app.post(`${V1}/visits/:id/recall`, guarded("queue.recall"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.recall(actor, { actorId: actor });
    });
  });

  app.post(`${V1}/visits/:id/start`, guarded("queue.start"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.startService(actor, { actorId: actor });
    });
  });

  app.post(`${V1}/visits/:id/skip`, guarded("queue.skip"), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const reason = optionalText(body["reason"], 200);
    if (!reason.ok) return reply.status(422).send({ error: "That reason is not valid." });
    await act(deps, request, reply, (visit, actor) => {
      visit.skip({ actorId: actor, reason: reason.value });
    });
  });

  app.post(`${V1}/visits/:id/complete`, guarded("queue.complete"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.complete({ actorId: actor });
    });
  });

  app.post(`${V1}/visits/:id/cancel`, guarded("visit.cancel"), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const reason = optionalText(body["reason"], 200);
    if (!reason.ok) return reply.status(422).send({ error: "That reason is not valid." });
    await act(deps, request, reply, (visit, actor) => {
      visit.cancel({ actorId: actor, reason: reason.value });
    });
  });

  /**
   * Changes a visit's priority.
   *
   * The escalation path the permission catalogue always had and the API did
   * not. Recorded as its own event, so a manager can see who moved a patient up
   * the queue and when.
   */
  app.post(`${V1}/visits/:id/priority`, guarded("visit.escalate"), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!isPriority(body["priority"])) {
      return reply.status(422).send({
        error: "Priority must be one of emergency, high, vip or normal.",
      });
    }
    const priority = body["priority"];
    const reason = optionalText(body["reason"], 200);
    if (!reason.ok) return reply.status(422).send({ error: "That reason is not valid." });
    await act(deps, request, reply, (visit, actor) => {
      visit.changePriority(priority, { actorId: actor, reason: reason.value });
    });
  });

  /**
   * Issues a new tracking token, for reprinting a ticket.
   *
   * The token is returned once at admission and only its hash is kept, so a
   * reprint cannot recover it. Minting a new one is the honest alternative,
   * and it retires the QR on the old ticket — which is what a reprint for a
   * lost ticket should do anyway.
   */
  app.post(`${V1}/visits/:id/tracking-token`, guarded("visit.create"), async (request, reply) => {
    const admission = deps.admission;
    if (admission === undefined) return reply.status(503).send({ error: "Not available." });
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.status(404).send({ error: "No such visit." });
    const visit = await deps.visits.find(tenantOf(request), VisitId(id));
    const branch = pinnedBranch(request);
    if (visit === null || (branch !== null && visit.branchId !== branch)) {
      return reply.status(404).send({ error: "No such visit." });
    }
    const token = admission.newTrackingToken();
    const reissued = await deps.visits.reissueTrackingToken(tenantOf(request), visit.id, admission.hashToken(token));
    if (!reissued) return reply.status(409).send({ error: "This visit is closed." });
    deps.logger.info("tracking token reissued", { requestId: request.requestId, visitId: visit.id });
    return reply.status(200).send({ trackingToken: token });
  });

  /**
   * One visit, for the reception's detail view and reprinting.
   *
   * Includes its history, which is the visit's own audit trail and carries no
   * identity of its own.
   */
  app.get(`${V1}/visits/:id`, guarded("reports.view"), async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.status(404).send({ error: "No such visit." });
    const visit = await deps.visits.find(tenantOf(request), VisitId(id));
    const branch = pinnedBranch(request);
    if (visit === null || (branch !== null && visit.branchId !== branch)) {
      return reply.status(404).send({ error: "No such visit." });
    }
    const history = await deps.events.forVisit(tenantOf(request), visit.id);
    return reply.status(200).send({
      visit: describeVisit(visit, mayViewIdentity(request)),
      history: history.map((recorded) => describeEvent(recorded).payload),
    });
  });

  /**
   * The event log, for the Activity Timeline and the Audit Log.
   *
   * Operational events need `reports.view`. Administrative and security events
   * are the audit log, which records who changed which permission and who
   * signed in from where; they additionally need an administrative permission.
   * Asking for the audit log without one is refused rather than quietly
   * narrowed, so a screen never presents half a log as the whole.
   */
  app.get(`${V1}/events`, guarded("reports.view"), async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;

    let limit: number | undefined;
    if (query["limit"] !== undefined) {
      limit = Number(query["limit"]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return reply.status(400).send({ error: "limit must be a whole number from 1 to 500." });
      }
    }
    let before: number | undefined;
    if (query["before"] !== undefined) {
      before = Number(query["before"]);
      if (!Number.isInteger(before) || before < 1) {
        return reply.status(400).send({ error: "before must be a positive whole number." });
      }
    }

    const mayAudit = AUDIT_PERMISSIONS.some((permission) => holds(request, permission));
    let categories: ActivityCategory[];
    if (query["category"] === undefined) {
      categories = mayAudit ? ["operational", ...AUDIT_CATEGORIES] : ["operational"];
    } else {
      const requested = query["category"].split(",").map((c) => c.trim());
      const known: readonly string[] = ["operational", ...AUDIT_CATEGORIES];
      if (requested.some((c) => !known.includes(c))) {
        return reply.status(400).send({ error: "Unknown event category." });
      }
      categories = requested as ActivityCategory[];
      if (!mayAudit && categories.some((c) => AUDIT_CATEGORIES.includes(c))) {
        return reply.status(403).send({
          error: "You do not have permission to read the audit log.",
          permission: "admin.settings",
        });
      }
    }

    const branch = pinnedBranch(request);
    const requestedBranch = query["branchId"];
    if (requestedBranch !== undefined && !isUuid(requestedBranch)) {
      return reply.status(400).send({ error: "That branch is not valid." });
    }
    if (branch !== null && requestedBranch !== undefined && requestedBranch !== branch) {
      return reply.status(403).send({ error: "That is another branch." });
    }
    const branchId = branch ?? requestedBranch;

    const eventQuery: EventQuery = {
      categories,
      ...(branchId ? { branchId: BranchId(branchId) } : {}),
      ...(query["correlationId"] ? { correlationId: query["correlationId"].slice(0, 100) } : {}),
      ...(query["search"] ? { search: query["search"].slice(0, 100) } : {}),
      ...(query["visitId"] && isUuid(query["visitId"]) ? { visitId: query["visitId"] } : {}),
      ...(query["actorId"] && isUuid(query["actorId"])
        ? { actorId: UserId(query["actorId"]) }
        : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(before !== undefined ? { before } : {}),
    };

    const records = await deps.events.query(tenantOf(request), eventQuery);
    return reply.status(200).send({
      events: records.map((recorded) => ({
        ...(describeEvent(recorded).payload as Record<string, unknown>),
        category: recorded.category,
        sequence: recorded.sequence,
      })),
      // The cursor for the next page, when there may be one.
      nextBefore:
        records.length > 0 && records.length === (limit ?? DEFAULT_EVENT_PAGE_SIZE)
          ? records[records.length - 1]!.sequence
          : null,
    });
  });
}
