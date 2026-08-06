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
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  InvariantViolationError,
  BranchId,
  StationId,
  UserId,
  VisitId,
  type Permission,
  type QueueTicket,
  visitToWire,
  type Visit,
  type WorkflowId,
} from "@qman/domain";
import type {
  ConfigurationRepository,
  EventRepository,
  VisitRepository,
} from "@qman/persistence";
import { admit, ticketForRoute, type AdmissionDependencies } from "./admission.js";
import { requirePermission, tenantOf, type GuardDependencies } from "./authorization.js";
import { describeEvent, type EventStream } from "./stream.js";
import { toNewEvent } from "./visit-events.js";
import type { Logger } from "./logging.js";
import { guard, record, type IdempotencyDependencies } from "./idempotency.js";
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

/**
 * What a queue entry looks like to a client.
 *
 * Assembled field by field. Serialising the aggregate would export whatever it
 * happens to hold, so a field added to the domain later — a clinical note, a
 * diagnosis code — would begin reaching display boards without anyone deciding
 * that it should.
 */
function describeVisit(visit: Visit): Record<string, unknown> {
  const entry = visit.currentEntry;
  return {
    /**
     * The aggregate's own state, so a staff surface can rehydrate the visit and
     * call the same domain projections the server would — queue position,
     * estimated wait, station health. Shipping rendered numbers instead would
     * mean an endpoint per projection and a second implementation of each the
     * first time a screen wanted one the API did not already return.
     *
     * Staff only. The display board and patient tracker have their own
     * projections, which carry neither the patient nor the Journey Code.
     */
    state: visitToWire(visit),
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
 * Runs one aggregate action and persists what it produced.
 *
 * `InvariantViolationError` becomes 409, not 400 or 500. The request was
 * well-formed and the caller was entitled to make it; the visit was simply not
 * in a state where it made sense — usually because someone else acted first.
 * "Conflict" is what that is, and the distinction matters to the receptionist,
 * who needs to know their screen is stale rather than that they did something
 * wrong.
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

  const visit = await deps.visits.find(VisitId(id));

  if (visit === null) {
    await respond(404, { error: "No such visit." });
    return;
  }

  if (visit.branchId !== authenticated.session.branchId && authenticated.session.branchId !== null) {
    await respond(403, { error: "That visit is in another branch." });
    return;
  }

  try {
    const prepared = (prepare ? await prepare(visit) : undefined) as TPrepared;
    apply(visit, authenticated.user.account.id, prepared);
  } catch (error) {
    if (error instanceof InvariantViolationError) {
      // Events recorded before the throw are discarded with it: the aggregate
      // rejected the action, so nothing happened worth publishing.
      visit.pullEvents();
      await respond(409, { error: error.message, code: error.code });
      return;
    }
    if (deps.idempotency && guarded.key !== null) {
      // The claim must not outlive a failure, or the retry this exists to
      // support would be answered with a stored error instead of running.
      await record(deps.idempotency, request, guarded.key, 500, null);
    }
    throw error;
  }

  const pending = visit.pullEvents();
  const records = pending.map((event) =>
    toNewEvent(event, {
      hospitalId: tenantOf(request),
      sessionId: authenticated.session.id,
    }),
  );

  await deps.visits.save(visit, records);

  // Published only after the write has landed. A subscriber that acted on an
  // event for a change still in flight would be reacting to something that
  // might yet roll back.
  // The stream is handed the record, never a rendered payload: it renders one
  // per audience, so a board cannot receive the staff projection.
  for (const record of records) {
    deps.stream.publish({
      ...record,
      id: `${visit.id}-${record.occurredAt.getTime()}-${record.type}`,
      sequence: 0,
      recordedAt: record.occurredAt,
    });
  }

  await respond(200, { visit: describeVisit(visit) });
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
   * starts. The browser used to do this against its own copy of the
   * configuration, which is how a ticket could be numbered from one version of
   * a template while the manager's SLA was measured against another.
   */
  app.post(`${V1}/visits`, guarded("visit.create"), async (request, reply) => {
    if (deps.admission === undefined) {
      return reply.status(503).send({ error: "Admission is not available." });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body["patientName"] === "string" ? body["patientName"].trim() : "";
    if (name === "") {
      return reply.status(400).send({ error: "A visit needs a patient name." });
    }

    const authenticated = request.authenticated!;
    const configuration = await deps.admission.configuration.load(
      tenantOf(request),
    );
    if (configuration === null) {
      return reply.status(500).send({ error: "Configuration unavailable." });
    }

    const branchId = (authenticated.session.branchId ??
      configuration.branches.find((b) => b.isDefault)?.id ??
      configuration.branches[0]?.id) as BranchId | undefined;
    if (branchId === undefined) {
      return reply.status(500).send({ error: "This hospital has no branches." });
    }

    const workflowId = (typeof body["workflowId"] === "string"
      ? body["workflowId"]
      : (configuration.workflows.find((w) => w.isDefault) ?? configuration.workflows[0])
          ?.id) as WorkflowId | undefined;
    if (workflowId === undefined) {
      return reply.status(422).send({ error: "This hospital has no workflow to admit into." });
    }

    let admission;
    try {
      admission = await admit(
        deps.admission,
        configuration,
        {
          branchId,
          workflowId,
          patient: {
            name,
            hospitalNumber:
              typeof body["hospitalNumber"] === "string" ? body["hospitalNumber"] : null,
            phone: typeof body["phone"] === "string" ? body["phone"] : null,
          },
          ...(typeof body["priority"] === "string"
            ? { priority: body["priority"] as never }
            : {}),
          actorId: authenticated.user.account.id,
        },
        deps.admission.newTrackingToken,
        deps.admission.hashToken,
      );
    } catch (error) {
      if (error instanceof InvariantViolationError) {
        return reply.status(409).send({ error: error.message, code: error.code });
      }
      throw error;
    }

    const records = admission.visit
      .pullEvents()
      .map((event) =>
        toNewEvent(event, {
          hospitalId: tenantOf(request),
          sessionId: authenticated.session.id,
        }),
      );

    await deps.visits.save(admission.visit, records, {
      trackingTokenHash: deps.admission.hashToken(admission.trackingToken),
    });

    for (const record of records) {
      deps.stream.publish({
        ...record,
        id: `${admission.visit.id}-${record.occurredAt.getTime()}-${record.type}`,
        sequence: 0,
        recordedAt: record.occurredAt,
      });
    }

    // The token is returned exactly once, to be printed into the QR code. It is
    // never readable again: only its hash is stored.
    return reply.status(201).send({
      visit: describeVisit(admission.visit),
      trackingToken: admission.trackingToken,
    });
  });

  /**
   * Routes a visit onward.
   *
   * Leaving the workflow is a separate permission from routing within it,
   * because sending a patient somewhere the workflow does not provide for is a
   * deliberate override rather than an ordinary step.
   */
  app.post(`${V1}/visits/:id/route`, guarded("queue.route"), async (request, reply) => {
    if (deps.admission === undefined) {
      return reply.status(503).send({ error: "Routing is not available." });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const toStationId = typeof body["stationId"] === "string" ? body["stationId"] : "";
    if (toStationId === "") {
      return reply.status(400).send({ error: "A destination station is required." });
    }

    const configuration = await deps.admission.configuration.load(
      tenantOf(request),
    );
    if (configuration === null) {
      return reply.status(500).send({ error: "Configuration unavailable." });
    }

    const followedWorkflow = body["followedWorkflow"] !== false;
    if (!followedWorkflow && !request.authenticated!.user.permissions.includes("queue.route_off_workflow")) {
      return reply.status(403).send({
        error: "You do not have permission to route outside the workflow.",
        permission: "queue.route_off_workflow",
      });
    }

    const admission = deps.admission;
    await act<QueueTicket>(
      deps,
      request,
      reply,
      (visit, actor, ticket) => {
        visit.routeTo(StationId(toStationId), ticket, { actorId: actor, followedWorkflow });
      },
      // The ticket is an argument to the transition rather than a consequence
      // of it, so it is allocated first — for this request, not from a map.
      (visit) => ticketForRoute(admission, configuration, visit, StationId(toStationId)),
    );
  });

  app.get(`${V1}/stations/:stationId/queue`, guarded("queue.call"), async (request, reply) => {
    const { stationId } = request.params as { stationId: string };
    const visits = await deps.visits.openAtStation(StationId(stationId));
    return reply.status(200).send({ visits: visits.map(describeVisit) });
  });

  app.get(`${V1}/branches/:branchId/visits`, guarded("reports.view"), async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const visits = await deps.visits.activeInBranch(BranchId(branchId));
    return reply.status(200).send({ visits: visits.map(describeVisit) });
  });

  app.post(`${V1}/visits/:id/call`, guarded("queue.call"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.call(actor, { actorId: actor });
    });
  });

  /**
   * Recall is the same aggregate action; the transition table decides which it
   * is from the current status. Two endpoints because they are two different
   * intentions, carrying two different permissions — a role may be allowed to
   * call patients without being allowed to keep recalling one.
   */
  app.post(`${V1}/visits/:id/recall`, guarded("queue.recall"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.call(actor, { actorId: actor });
    });
  });

  app.post(`${V1}/visits/:id/start`, guarded("queue.start"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.startService(actor, { actorId: actor });
    });
  });

  app.post(`${V1}/visits/:id/skip`, guarded("queue.skip"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.skip({ actorId: actor });
    });
  });

  app.post(`${V1}/visits/:id/complete`, guarded("queue.complete"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.complete({ actorId: actor });
    });
  });

  app.post(`${V1}/visits/:id/cancel`, guarded("visit.cancel"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.cancel({ actorId: actor });
    });
  });

  app.get(`${V1}/events`, guarded("reports.view"), async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const records = await deps.events.query({
      ...(query["branchId"] ? { branchId: BranchId(query["branchId"]) } : {}),
      ...(query["correlationId"] ? { correlationId: query["correlationId"] } : {}),
      ...(query["limit"] ? { limit: Number(query["limit"]) } : {}),
    });
    return reply.status(200).send({ events: records.map((record) => describeEvent(record).payload) });
  });
}
