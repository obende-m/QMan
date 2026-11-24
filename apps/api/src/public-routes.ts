/**
 * The two unauthenticated surfaces.
 *
 * Display Board and Patient Tracker are separate trust domains from the staff
 * application and from each other. Neither carries a session, neither can hold
 * a permission, and both are reachable by anyone who can reach the server. What
 * protects them is not authentication but the shape of what they can ask for
 * and the shape of what they are told.
 *
 * **The board asks for a room's worth of information and receives exactly
 * that** — tickets, stations, statuses, rooms and times. Everything on it is
 * already legible to anyone standing in the waiting area. It never receives a
 * patient identity, and never a Journey Code: the code is printed on a
 * patient's own ticket and opens their tracking page, so a board that showed it
 * would turn a photograph of the screen into a set of other people's lookup
 * keys.
 *
 * **The tracker asks about one visit and must prove which one.** A long random
 * token in the QR code does that. The Journey Code remains usable by hand,
 * because a patient whose phone cannot scan still needs their queue position,
 * but that path is rate limited and tells the caller less.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isJourneyCode, normaliseJourneyCode, type BranchId, type Visit } from "@qman/domain";
import type { ConfigurationRepository, VisitRepository } from "@qman/persistence";
import { boardSnapshot, trackSnapshot } from "./public-projection.js";
import { isUuid } from "./identifiers.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import { hashToken } from "./tokens.js";
import type { OrganizationDirectoryRepository } from "@qman/persistence";
import type { Logger } from "./logging.js";
import { V1 } from "./version.js";

export interface PublicRouteDependencies {
  readonly visits: VisitRepository;
  readonly logger: Logger;
  readonly now: () => Date;
  /** Resolves a board id to the branch and stations it displays. */
  readonly boards: BoardDirectory;
  /**
   * Used only to ask whether the organization behind a branch is suspended.
   *
   * The public surfaces are the reason suspension means anything to the people
   * standing in the building. A suspended hospital whose display boards kept
   * calling patients would be suspended in billing terms and running in every
   * other sense.
   */
  readonly organizations: OrganizationDirectoryRepository;
  readonly trackerLimiter?: RateLimiter;
  /**
   * The organization's configuration, for station names, rooms and wait
   * estimates. Every deployment supplies it; without it the surfaces fall back
   * to tickets and statuses alone.
   */
  readonly configuration?: ConfigurationRepository;
}

export interface BoardDefinition {
  readonly id: string;
  readonly branchId: string;
  readonly name: string;
  readonly stationIds: readonly string[];
}

export interface BoardDirectory {
  find(boardId: string): Promise<BoardDefinition | null>;
}

/**
 * Whether a branch's organization is active.
 *
 * False for a suspended organization and false for a branch that does not
 * exist, so every caller can treat both as "not found" without deciding which
 * it was.
 */
export async function servingPublicly(
  deps: PublicRouteDependencies,
  branchId: string,
): Promise<boolean> {
  const organization = await deps.organizations.findByBranch(branchId);
  return organization !== null && organization.status === "active";
}

/**
 * Manual Journey Code entry, throttled hard.
 *
 * The code is short by design, so without this an attacker walks the space. Six
 * attempts a minute is generous for someone squinting at a paper ticket and
 * useless for enumeration: at that rate a meaningful fraction of the space
 * takes years, and the branch and open-visit scoping shrink what is reachable
 * to the codes issued today.
 */
export const JOURNEY_CODE_RATE_LIMIT = { limit: 6, windowMillis: 60_000 };

/**
 * What a waiting-room screen is told about one queue entry.
 *
 * Assembled explicitly. No patient name, no Journey Code, no visit id — an
 * internal identifier correlates a person across stations for anyone who
 * collects them, and a board is the easiest place in the hospital to collect
 * from.
 */
function describeForBoard(
  entry: {
    stationId: string;
    queueLabel: string;
    status: string;
    calledAt: Date | null;
    queuedAt: Date;
  },
  room: string | null,
): Record<string, unknown> {
  return {
    stationId: entry.stationId,
    ticket: entry.queueLabel,
    status: entry.status,
    room,
    queuedAt: entry.queuedAt.toISOString(),
    calledAt: entry.calledAt?.toISOString() ?? null,
  };
}

/**
 * What a patient is told about their own visit.
 *
 * Queue information only. QMan holds no clinical data — that stays in the HMS —
 * but the rule is stated here because this is the endpoint where a future
 * temptation to add "helpful" detail would land, and where it must be refused.
 */
function describeForPatient(visit: Visit): Record<string, unknown> {
  const entry = visit.currentEntry;
  return {
    status: visit.status,
    journeyCode: visit.journeyCode,
    stationsVisited: visit.stationsVisited,
    current: entry
      ? {
          stationId: entry.stationId,
          ticket: entry.queueLabel,
          status: entry.status,
          queuedAt: entry.queuedAt.toISOString(),
          calledAt: entry.calledAt?.toISOString() ?? null,
        }
      : null,
  };
}

/**
 * The patient's view, with station names, position and wait when the
 * configuration is available.
 */
async function patientView(
  deps: PublicRouteDependencies,
  hospitalId: string,
  visit: Visit,
): Promise<Record<string, unknown>> {
  const base = { visit: describeForPatient(visit) };
  const configuration = await deps.configuration?.load(hospitalId);
  const stationId = visit.currentStationId;
  if (!configuration) return base;
  const atStation = stationId
    ? (await deps.visits.openAtStation(hospitalId, stationId)).filter((v) => v.branchId === visit.branchId)
    : [];
  return { ...base, track: trackSnapshot(configuration, visit, atStation, deps.now()) };
}

function clientKey(request: FastifyRequest): string {
  return request.ip;
}

export function registerPublicRoutes(
  app: FastifyInstance,
  deps: PublicRouteDependencies,
): void {
  const limiter = deps.trackerLimiter ?? createRateLimiter(JOURNEY_CODE_RATE_LIMIT);

  /**
   * A board's current contents.
   *
   * Unauthenticated on purpose: a screen bolted to a waiting-room wall has
   * nobody to sign in, and giving it a credential would mean a credential
   * living in a kiosk browser that anyone can open.
   */
  app.get(`${V1}/public/boards/:boardId`, async (request, reply) => {
    const { boardId } = request.params as { boardId: string };
    if (!isUuid(boardId)) return reply.status(404).send({ error: "No such board." });
    const board = await deps.boards.find(boardId);

    if (board === null) {
      return reply.status(404).send({ error: "No such board." });
    }

    const organization = await deps.organizations.findByBranch(board.branchId);
    if (organization === null || organization.status !== "active") {
      // Answered exactly as a missing board is. A screen in a waiting room
      // shows "this board is not configured" either way, and distinguishing
      // the two would publish the commercial status of a hospital to anyone
      // who can reach the endpoint.
      return reply.status(404).send({ error: "No such board." });
    }

    // Scoped to the organization the board belongs to, resolved from the board
    // rather than from anything the caller sent.
    const visits = await deps.visits.activeInBranch(
      organization.id,
      board.branchId as BranchId,
    );
    const stations = new Set(board.stationIds);

    const entries = visits
      .map((visit) => visit.currentEntry)
      .filter(
        (entry): entry is NonNullable<typeof entry> =>
          entry !== undefined && entry !== null && stations.has(entry.stationId),
      )
      .map((entry) => describeForBoard(entry, null));

    // A board polls, so it must not be served from a cache between polls.
    void reply.header("Cache-Control", "no-store");

    const configuration = await deps.configuration?.load(organization.id);
    const configured = configuration?.displayBoards.find((b) => b.id === board.id);
    if (configuration && configured) {
      const snapshot = boardSnapshot(configuration, configured, visits, deps.now());
      return reply.status(200).send({
        ...snapshot,
        board: { ...(snapshot["board"] as object), stationIds: board.stationIds },
        entries,
      });
    }

    return reply.status(200).send({
      board: { id: board.id, name: board.name, stationIds: board.stationIds },
      entries,
      at: deps.now().toISOString(),
    });
  });

  /**
   * A visit, identified by the token in its QR code.
   *
   * The token is looked up by hash, so the value the patient holds exists on the
   * server only for the length of the request.
   */
  app.get(`${V1}/public/track/token/:token`, async (request, reply) => {
    const { token } = request.params as { token: string };

    if (typeof token !== "string" || token.length < 20 || token.length > 200) {
      return reply.status(404).send({ error: "That tracking link is not valid." });
    }

    const visit = await deps.visits.findByTrackingToken(hashToken(token));
    if (visit === null) {
      return reply.status(404).send({ error: "That tracking link is not valid." });
    }

    const owner = await deps.organizations.findByBranch(visit.branchId);
    if (owner === null || owner.status !== "active") {
      return reply.status(404).send({ error: "That tracking link is not valid." });
    }

    void reply.header("Cache-Control", "no-store");
    return reply.status(200).send(await patientView(deps, owner.id, visit));
  });

  /**
   * A visit, identified by a Journey Code typed in by hand.
   *
   * Kept because a patient whose phone will not scan still needs to know where
   * they are in the queue, and telling them to ask at the desk defeats the point
   * of the tracker. Throttled hard, because the code is short.
   *
   * A wrong code and a code that has been closed give the same answer. Telling
   * them apart would confirm which codes were ever real, which is most of what
   * an enumerator wants.
   */
  app.post(`${V1}/public/track/code`, async (request, reply) => {
    const decision = limiter.check(clientKey(request), deps.now());
    if (!decision.allowed) {
      deps.logger.warn("journey code lookup rate limited", {
        requestId: request.requestId,
        address: request.ip,
      });
      return reply
        .status(429)
        .header(
          "Retry-After",
          Math.ceil((decision.retryAfter.getTime() - deps.now().getTime()) / 1000),
        )
        .send({ error: "Too many attempts. Wait a moment and try again." });
    }

    const body = (request.body ?? {}) as { code?: unknown; branchId?: unknown };
    const rawCode = typeof body.code === "string" ? body.code : "";
    const branchId = typeof body.branchId === "string" ? body.branchId : "";

    if (rawCode === "" || branchId === "") {
      return reply.status(400).send({ error: "Enter the code from your ticket." });
    }

    // Repairs the mis-reads a paper ticket produces — I for J, O for Q, 1 for J.
    const code = normaliseJourneyCode(rawCode);
    if (!isJourneyCode(code)) {
      // Answered exactly as a valid-but-unknown code is. Distinguishing
      // "malformed" from "not found" tells an enumerator which shapes are real.
      return reply.status(404).send({ error: "That code was not found." });
    }

    if (!isUuid(branchId)) {
      return reply.status(404).send({ error: "That code was not found." });
    }
    const owner = await deps.organizations.findByBranch(branchId);
    if (owner === null || owner.status !== "active") {
      return reply.status(404).send({ error: "That code was not found." });
    }

    const visit = await deps.visits.findByJourneyCode(branchId as BranchId, code);
    if (visit === null) {
      return reply.status(404).send({ error: "That code was not found." });
    }

    void reply.header("Cache-Control", "no-store");
    return reply.status(200).send(await patientView(deps, owner.id, visit));
  });
}
