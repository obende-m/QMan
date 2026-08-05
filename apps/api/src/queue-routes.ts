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
  type Visit,
} from "@qman/domain";
import type { EventRepository, VisitRepository } from "@qman/persistence";
import { requirePermission, type GuardDependencies } from "./authorization.js";
import { describeEvent, type EventStream } from "./stream.js";
import { toNewEvent } from "./visit-events.js";
import type { Logger } from "./logging.js";

export interface QueueRouteDependencies {
  readonly guards: GuardDependencies;
  readonly visits: VisitRepository;
  readonly events: EventRepository;
  readonly stream: EventStream;
  readonly logger: Logger;
  readonly resolveHospital: (request: FastifyRequest) => string;
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
async function act(
  deps: QueueRouteDependencies,
  request: FastifyRequest,
  reply: FastifyReply,
  apply: (visit: Visit, actor: UserId) => void,
): Promise<void> {
  const { id } = request.params as { id: string };
  const authenticated = request.authenticated!;
  const visit = await deps.visits.find(VisitId(id));

  if (visit === null) {
    void reply.status(404).send({ error: "No such visit." });
    return;
  }

  if (visit.branchId !== authenticated.session.branchId && authenticated.session.branchId !== null) {
    void reply.status(403).send({ error: "That visit is in another branch." });
    return;
  }

  try {
    apply(visit, authenticated.user.account.id);
  } catch (error) {
    if (error instanceof InvariantViolationError) {
      // Events recorded before the throw are discarded with it: the aggregate
      // rejected the action, so nothing happened worth publishing.
      visit.pullEvents();
      void reply.status(409).send({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }

  const pending = visit.pullEvents();
  const records = pending.map((event) =>
    toNewEvent(event, {
      hospitalId: deps.resolveHospital(request),
      sessionId: authenticated.session.id,
    }),
  );

  await deps.visits.save(visit, records);

  // Published only after the write has landed. A subscriber that acted on an
  // event for a change still in flight would be reacting to something that
  // might yet roll back.
  for (const record of records) {
    deps.stream.publish(
      describeEvent({
        ...record,
        id: `${visit.id}-${record.occurredAt.getTime()}-${record.type}`,
        sequence: 0,
        recordedAt: record.occurredAt,
      }),
    );
  }

  void reply.status(200).send({ visit: describeVisit(visit) });
}

export function registerQueueRoutes(app: FastifyInstance, deps: QueueRouteDependencies): void {
  const guarded = (permission: Permission) => ({
    preHandler: requirePermission(deps.guards, permission),
  });

  app.get("/api/stations/:stationId/queue", guarded("queue.call"), async (request, reply) => {
    const { stationId } = request.params as { stationId: string };
    const visits = await deps.visits.openAtStation(StationId(stationId));
    return reply.status(200).send({ visits: visits.map(describeVisit) });
  });

  app.get("/api/branches/:branchId/visits", guarded("reports.view"), async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const visits = await deps.visits.activeInBranch(BranchId(branchId));
    return reply.status(200).send({ visits: visits.map(describeVisit) });
  });

  app.post("/api/visits/:id/call", guarded("queue.call"), async (request, reply) => {
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
  app.post("/api/visits/:id/recall", guarded("queue.recall"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.call(actor, { actorId: actor });
    });
  });

  app.post("/api/visits/:id/start", guarded("queue.start"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.startService(actor, { actorId: actor });
    });
  });

  app.post("/api/visits/:id/skip", guarded("queue.skip"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.skip({ actorId: actor });
    });
  });

  app.post("/api/visits/:id/complete", guarded("queue.complete"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.complete({ actorId: actor });
    });
  });

  app.post("/api/visits/:id/cancel", guarded("visit.cancel"), async (request, reply) => {
    await act(deps, request, reply, (visit, actor) => {
      visit.cancel({ actorId: actor });
    });
  });

  app.get("/api/events", guarded("reports.view"), async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const records = await deps.events.query({
      ...(query["branchId"] ? { branchId: BranchId(query["branchId"]) } : {}),
      ...(query["correlationId"] ? { correlationId: query["correlationId"] } : {}),
      ...(query["limit"] ? { limit: Number(query["limit"]) } : {}),
    });
    return reply.status(200).send({ events: records.map((record) => describeEvent(record).payload) });
  });
}
