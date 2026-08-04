import {
  DEFAULT_PRIORITY_WEIGHTS,
  UserId,
  assessStation,
  availableDestinations,
  clinicPulse,
  estimateWaitMillis,
  longestWaitingPatient,
  orderQueue,
  parseJourneyCode,
  positionOf,
  priorityWeight,
  rankBottlenecks,
  resolveRoute,
  staffWorkloads,
  type ClinicPulse,
  type LongestWaiting,
  type Priority,
  type QueueItem,
  type StaffWorkload,
  type StationHealth,
  type StationId,
  type StationWorklist,
  type VisitEvent,
  type VisitId,
} from "@qman/domain";
import {
  allStations,
  currentWorkflow,
  issueTicketFor,
  queueItemsFor,
  seedVisits,
  slaFor,
  stationServiceEstimate,
  stationStaffing,
  worklistFor,
  type DemoVisit,
} from "./demo-clinic.js";
import type { EventBus } from "./event-bus.js";

/**
 * The clinic store.
 *
 * Every mutation goes through the `Visit` aggregate — the store never assigns a
 * status or edits a queue entry itself. Its job is the three things the
 * aggregate deliberately cannot do: hold the collection of visits, allocate
 * per-station queue numbers, and publish the events each action produced.
 *
 * That makes it the exact seam the backend replaces. When the API lands, the
 * method bodies call it and the event feed arrives over a socket instead of
 * from `pullEvents()` — every component above this file is unchanged, because
 * they already only see domain types.
 */

export type ActionResult =
  | { ok: true }
  | { ok: false; message: string };

const OK: ActionResult = { ok: true };

function fail(message: string): ActionResult {
  return { ok: false, message };
}

export class ClinicStore {
  #visits: DemoVisit[] = seedVisits();
  #events: VisitEvent[] = [];
  #version = 0;
  #heartbeat = 0;
  #listeners = new Set<() => void>();
  #bus: EventBus | null = null;

  /**
   * Attaches an event bus. Everything downstream of a clinical action —
   * announcements, notifications, the audit trail, telemetry — subscribes to
   * the bus rather than being called from here, so the queue engine stays
   * ignorant of them.
   */
  useBus(bus: EventBus): this {
    this.#bus = bus;
    return this;
  }

  // ------------------------------------------------------------ subscription

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * A monotonic version, not the visit array. `useSyncExternalStore` compares
   * snapshots by identity, and the aggregates are mutated in place — returning
   * the array would compare equal after every action and never re-render.
   */
  getVersion = (): number => this.#version;

  /**
   * Source liveness, distinct from `version`.
   *
   * `version` changes only when the clinic changes. A quiet half-hour would
   * therefore look identical to a dead connection, and a board would wrongly
   * declare itself stale during a lull. `heartbeat` also advances on a
   * keepalive, so it answers "is the source still there" rather than "has
   * anything happened".
   *
   * Deliberately does not notify subscribers: surfaces that care read it on
   * their own render tick, and a keepalive that re-rendered the whole
   * application every fifteen seconds would be a poor trade for a status dot.
   */
  get heartbeat(): number {
    return this.#heartbeat;
  }

  /** Called by the transport — today a local timer, later a socket. */
  keepAlive(): void {
    this.#heartbeat += 1;
  }

  // ----------------------------------------------------------------- queries

  get visits(): readonly DemoVisit[] {
    return this.#visits;
  }

  /** Most recent first. Drives the Live Activity feed. */
  get events(): readonly VisitEvent[] {
    return this.#events;
  }

  find(visitId: VisitId): DemoVisit | undefined {
    return this.#visits.find(({ visit }) => visit.id === visitId);
  }

  worklist(stationId: StationId): StationWorklist {
    return worklistFor(this.#visits, stationId);
  }

  /** The station's waiting list, in the exact order it should be served. */
  waitingAt(stationId: StationId): readonly QueueItem[] {
    return this.worklist(stationId).waiting;
  }

  /**
   * Visits needing attention regardless of when they arrived.
   *
   * Sorted by clinical weight then by how long they have been waiting, so the
   * patient who is both urgent and longest-waiting is always first.
   */
  priorityVisits(): DemoVisit[] {
    return this.#visits
      .filter(({ visit }) => {
        if (visit.status === "completed" || visit.status === "closed") return false;
        if (visit.status === "cancelled") return false;
        return visit.priority === "emergency" || visit.priority === "high";
      })
      .sort((a, b) => {
        const byPriority =
          priorityWeight(b.visit.priority, DEFAULT_PRIORITY_WEIGHTS) -
          priorityWeight(a.visit.priority, DEFAULT_PRIORITY_WEIGHTS);
        if (byPriority !== 0) return byPriority;
        return a.arrivedAt.getTime() - b.arrivedAt.getTime();
      });
  }

  /** Destinations a station may send its current patient to. */
  destinationsFrom(stationId: StationId) {
    return availableDestinations(currentWorkflow(), stationId);
  }

  // ------------------------------------------------------- position & waiting

  /**
   * A visit's live position in its current station queue, 1-based.
   *
   * Deliberately derived on every read rather than stored. The ticket is fixed
   * for the whole stop; the position moves every time the queue does, and a
   * stored position would be wrong the instant anyone else was called.
   * Null when the patient is being served, or is not waiting anywhere.
   */
  positionOf(visitId: VisitId): number | null {
    const found = this.find(visitId);
    const stationId = found?.visit.currentStationId;
    if (!found || !stationId) return null;
    return positionOf(visitId, this.worklist(stationId).waiting);
  }

  /** How many patients are ahead of this visit right now. */
  aheadOf(visitId: VisitId): number | null {
    const position = this.positionOf(visitId);
    return position === null ? null : position - 1;
  }

  /**
   * Estimated wait for a visit, from its live position and the station's
   * observed service time today.
   */
  estimatedWaitMillis(visitId: VisitId): number | null {
    const found = this.find(visitId);
    const stationId = found?.visit.currentStationId;
    const position = this.positionOf(visitId);
    if (!found || !stationId || position === null) return null;

    return estimateWaitMillis({
      position,
      serversAvailable: stationStaffing(stationId),
      observedServiceMillis: this.worklist(stationId).averageServiceMillis,
      configuredServiceMillis:
        stationServiceEstimate(stationId),
    });
  }

  /** Estimated wait for whoever joins a station's queue next. */
  estimatedWaitForNewArrival(stationId: StationId): number {
    const worklist = this.worklist(stationId);
    return estimateWaitMillis({
      position: worklist.counts.waiting + 1,
      serversAvailable: stationStaffing(stationId),
      observedServiceMillis: worklist.averageServiceMillis,
      configuredServiceMillis:
        stationServiceEstimate(stationId),
    });
  }

  /** Finds a visit by Journey Code, tolerating however a patient typed it. */
  findByJourneyCode(input: string): DemoVisit | undefined {
    let code: string;
    try {
      code = parseJourneyCode(input);
    } catch {
      return undefined;
    }
    return this.#visits.find(({ visit }) => visit.journeyCode === code);
  }

  // --------------------------------------------------------------- analytics

  /** Worklists for every station the clinic operates. */
  allWorklists(): StationWorklist[] {
    return allStations().map((stationId) => this.worklist(stationId));
  }

  stationHealth(now: Date): StationHealth[] {
    return this.allWorklists().map((worklist) =>
      assessStation(worklist, slaFor(worklist.stationId), now),
    );
  }

  bottlenecks(now: Date): StationHealth[] {
    return rankBottlenecks(this.stationHealth(now));
  }

  pulse(now: Date): ClinicPulse {
    return clinicPulse(this.stationHealth(now), this.allWorklists());
  }

  longestWaiting(now: Date): LongestWaiting | null {
    return longestWaitingPatient(this.allWorklists(), now);
  }

  workloads(): StaffWorkload[] {
    return staffWorkloads(this.allWorklists());
  }

  // ----------------------------------------------------------------- actions

  /** Calls the next patient in line. Refuses if the station is mid-service. */
  callNext(stationId: StationId, userId: UserId): ActionResult {
    const worklist = this.worklist(stationId);
    if (worklist.current) {
      return fail(
        `${worklist.current.patientName} is still at this station. Complete or route them first.`,
      );
    }

    const [next] = orderQueue(worklist.waiting);
    if (!next) return fail("No patients are waiting at this station.");

    return this.#act(next.visitId, (visit) => {
      visit.call(userId);
      return OK;
    });
  }

  recall(visitId: VisitId, userId: UserId): ActionResult {
    return this.#act(visitId, (visit) => {
      visit.call(userId);
      return OK;
    });
  }

  startService(visitId: VisitId, userId: UserId): ActionResult {
    return this.#act(visitId, (visit) => {
      visit.startService(userId);
      return OK;
    });
  }

  skip(visitId: VisitId, reason: string | null, userId: UserId): ActionResult {
    return this.#act(visitId, (visit) => {
      visit.skip({ actorId: userId, reason });
      return OK;
    });
  }

  /**
   * Routes onward. With no destination the workflow decides, which is the
   * one-click path the vast majority of visits take.
   */
  route(
    visitId: VisitId,
    toStationId: StationId | undefined,
    userId: UserId,
  ): ActionResult {
    return this.#act(visitId, (visit) => {
      const decision = resolveRoute({
        workflow: currentWorkflow(),
        visit,
        requestedStationId: toStationId,
      });

      if (decision.kind === "complete") {
        visit.complete({ actorId: userId });
        return OK;
      }

      // The destination station issues the ticket, in its own format and from
      // its own series. The Journey Code travels with the visit unchanged.
      visit.routeTo(
        decision.toStationId,
        issueTicketFor(decision.toStationId, visit.journeyCode),
        { actorId: userId, followedWorkflow: decision.followedWorkflow },
      );
      return OK;
    });
  }

  complete(visitId: VisitId, userId: UserId): ActionResult {
    return this.#act(visitId, (visit) => {
      visit.complete({ actorId: userId });
      return OK;
    });
  }

  /** Raises clinical priority. The queue reorders on the next render. */
  escalate(
    visitId: VisitId,
    to: Priority,
    reason: string | null,
    userId: UserId,
  ): ActionResult {
    return this.#act(visitId, (visit) => {
      visit.changePriority(to, { actorId: userId, reason });
      return OK;
    });
  }

  // ----------------------------------------------------------------- private

  /**
   * Applies a domain action and commits its events.
   *
   * The aggregate throws a typed `DomainError` when an action is illegal from
   * the current state. Catching it here turns "the engine says no" into a
   * message the station can read, rather than a crashed screen — the same
   * mapping the API layer will do to HTTP status codes.
   */
  #act(
    visitId: VisitId,
    apply: (visit: DemoVisit["visit"]) => ActionResult,
  ): ActionResult {
    const found = this.find(visitId);
    if (!found) return fail("That visit is no longer on this board.");

    try {
      const result = apply(found.visit);
      this.#commit(found);
      return result;
    } catch (error) {
      // Any events recorded before the throw are discarded along with it: the
      // aggregate rejected the action, so nothing happened worth publishing.
      found.visit.pullEvents();
      return fail(
        error instanceof Error ? error.message : "That action is not allowed.",
      );
    }
  }

  #commit(entry: DemoVisit): void {
    const events = entry.visit.pullEvents();
    if (events.length > 0) {
      this.#events = [...events.reverse(), ...this.#events].slice(0, 100);
    }
    this.#version += 1;
    this.#heartbeat += 1;
    for (const listener of this.#listeners) listener();

    // Published after listeners, and after the state change is committed, so no
    // subscriber can observe an event for a change that has not landed.
    if (events.length > 0) {
      this.#bus?.publish([...events].reverse());
    }
  }
}

/**
 * One store for the running app. Tests construct their own so they never share
 * mutable clinic state between cases.
 */
export const clinicStore = new ClinicStore();

export const CURRENT_USER = UserId("user-doctor");
