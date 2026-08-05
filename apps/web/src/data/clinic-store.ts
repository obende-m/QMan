/**
 * The clinic store.
 *
 * Holds the visits the server owns, rebuilt as aggregates so the domain's
 * projections can be called on them. It decides nothing: every action is a
 * request, and the visit that comes back replaces the one held. The transition
 * table lives on the server, and a copy of it here would be a second opinion
 * that renders a button enabled for an action the API will refuse.
 *
 * **Actions replace from the response, not the request.** Each endpoint returns
 * the visit that resulted, so what is held afterwards is what was committed.
 * Re-fetching instead would open a window in which another workstation's action
 * is read as the effect of this one.
 *
 * **The stream invalidates rather than patches.** An event says something
 * changed; the store re-reads the branch. Applying event payloads directly
 * would mean maintaining a second reducer that has to agree with the aggregate
 * — and would silently diverge the first time an event was missed, which is
 * exactly what a reconnection guarantees will happen.
 */
import {
  UserId,
  availableDestinations,
  parseJourneyCode,
  priorityWeight,
  resolveRoute,
  visitFromWire,
  DEFAULT_PRIORITY_WEIGHTS,
  type ClinicPulse,
  type LongestWaiting,
  type QueueItem,
  type StaffWorkload,
  type StationHealth,
  type StationId,
  type StationWorklist,
  type Visit,
  type VisitDependencies,
  type VisitId,
} from "@qman/domain";
import { ApiError } from "../api/client.js";
import type { ConfigStore } from "./config-store.js";
import type { VisitsApi } from "./visits-api.js";
import * as projections from "./clinic-projections.js";

export type ActionResult = { ok: true } | { ok: false; message: string };

const OK: ActionResult = { ok: true };

function fail(message: string): ActionResult {
  return { ok: false, message };
}

/**
 * What a failed request means to someone standing at a desk.
 *
 * The typed failure is translated once, here, rather than in each screen. A
 * conflict is the interesting one: it means the visit moved on, usually because
 * a colleague acted first, and the useful instruction is to look again rather
 * than to try harder.
 */
function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) return "That action could not be completed.";
  switch (error.failure) {
    case "offline":
      return "Cannot reach the server. Check the connection and try again.";
    case "unauthenticated":
      return "Your session has ended. Sign in again.";
    case "forbidden":
      return error.permission
        ? `You do not have permission to do that (${error.permission}).`
        : "You do not have permission to do that.";
    case "conflict":
      return `${error.message} Refresh to see what changed.`;
    default:
      return error.requestId ? `${error.message} (reference ${error.requestId})` : error.message;
  }
}

export type ClinicStatus = "loading" | "ready" | "failed";

export class ClinicStore {
  #visits: Visit[] = [];
  #status: ClinicStatus = "loading";
  #error: ApiError | null = null;
  #version = 0;
  #heartbeat = 0;
  #listeners = new Set<() => void>();
  #branchId: string | null = null;
  /** Coalesces the reloads a burst of events would otherwise each trigger. */
  #pendingReload: Promise<void> | null = null;

  constructor(
    private readonly api: VisitsApi,
    private readonly config: ConfigStore,
    private readonly deps: VisitDependencies,
  ) {}

  // ------------------------------------------------------------ subscription

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * A monotonic version, not the visit array. `useSyncExternalStore` compares
   * snapshots by identity, and returning the array would compare equal after an
   * in-place change and never re-render.
   */
  getVersion = (): number => this.#version;

  /**
   * Source liveness, distinct from `version`.
   *
   * `version` changes only when the clinic changes, so a quiet half-hour would
   * look identical to a dead connection. `heartbeat` also advances on a
   * keepalive, answering "is the source still there" rather than "has anything
   * happened". It deliberately does not notify: a keepalive that re-rendered
   * the application every twenty seconds would be a poor trade for a status
   * dot.
   */
  get heartbeat(): number {
    return this.#heartbeat;
  }

  keepAlive(): void {
    this.#heartbeat += 1;
  }

  get status(): ClinicStatus {
    return this.#status;
  }

  get error(): ApiError | null {
    return this.#error;
  }

  // ----------------------------------------------------------------- loading

  async load(branchId: string): Promise<void> {
    this.#branchId = branchId;
    try {
      const response = await this.api.listForBranch(branchId);
      this.#visits = response.visits.map((visit) => visitFromWire(visit.state, this.deps));
      this.#status = "ready";
      this.#error = null;
    } catch (error) {
      this.#status = "failed";
      this.#error = error instanceof ApiError ? error : null;
    }
    this.#commit();
  }

  /**
   * Re-reads the branch after the stream said something changed.
   *
   * Concurrent calls share one request. A patient called at three stations in
   * the same second produces three events, and three overlapping reads would
   * land in an order nobody controls — the last to arrive winning, whether or
   * not it was the newest.
   */
  async invalidate(): Promise<void> {
    if (this.#branchId === null) return;
    this.#heartbeat += 1;
    if (this.#pendingReload !== null) return this.#pendingReload;

    const branchId = this.#branchId;
    this.#pendingReload = (async () => {
      try {
        const response = await this.api.listForBranch(branchId);
        this.#visits = response.visits.map((visit) => visitFromWire(visit.state, this.deps));
        this.#status = "ready";
        this.#error = null;
        this.#commit();
      } catch (error) {
        // A failed refresh leaves what is on screen alone. It is the last thing
        // the server said, which is better than an empty clinic — and the
        // connection indicator already reports that it is no longer fresh.
        this.#error = error instanceof ApiError ? error : null;
      } finally {
        this.#pendingReload = null;
      }
    })();

    return this.#pendingReload;
  }

  // ----------------------------------------------------------------- queries

  get visits(): readonly Visit[] {
    return this.#visits;
  }

  find(visitId: VisitId): Visit | undefined {
    return this.#visits.find((visit) => visit.id === visitId);
  }

  worklist(stationId: StationId): StationWorklist {
    return projections.worklistFor(this.#visits, stationId);
  }

  waitingAt(stationId: StationId): readonly QueueItem[] {
    return this.worklist(stationId).waiting;
  }

  /**
   * Visits needing attention regardless of when they arrived.
   *
   * Sorted by clinical weight then by arrival, so the patient who is both
   * urgent and longest-waiting is always first.
   */
  priorityVisits(): Visit[] {
    return this.#visits
      .filter((visit) => {
        if (visit.status === "completed" || visit.status === "closed") return false;
        if (visit.status === "cancelled") return false;
        return visit.priority === "emergency" || visit.priority === "high";
      })
      .sort((a, b) => {
        const byPriority =
          priorityWeight(b.priority, DEFAULT_PRIORITY_WEIGHTS) -
          priorityWeight(a.priority, DEFAULT_PRIORITY_WEIGHTS);
        if (byPriority !== 0) return byPriority;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
  }

  /** Destinations a station may send its current patient to. */
  destinationsFrom(stationId: StationId) {
    const workflow = this.config.defaultWorkflow();
    // One shape whether or not a workflow exists: a caller rendering buttons
    // should not have to tell an empty list from a missing one.
    if (workflow === undefined) return { options: [], canComplete: false };
    return availableDestinations(workflow, stationId);
  }

  positionOf(visitId: VisitId): number | null {
    return projections.positionOf(this.#visits, visitId);
  }

  aheadOf(visitId: VisitId): number | null {
    const position = this.positionOf(visitId);
    return position === null ? null : position - 1;
  }

  estimatedWaitMillis(visitId: VisitId): number | null {
    return projections.estimatedWaitMillis(this.#visits, this.config.config, visitId);
  }

  estimatedWaitForNewArrival(stationId: StationId): number {
    return projections.estimatedWaitForNewArrival(this.#visits, this.config.config, stationId);
  }

  /** Finds a visit by Journey Code, tolerating however a patient typed it. */
  findByJourneyCode(input: string): Visit | undefined {
    let code: string;
    try {
      code = parseJourneyCode(input);
    } catch {
      return undefined;
    }
    return this.#visits.find((visit) => visit.journeyCode === code);
  }

  // --------------------------------------------------------------- analytics

  allWorklists(): StationWorklist[] {
    return projections.allWorklists(this.#visits, this.config.config);
  }

  stationHealth(now: Date): StationHealth[] {
    return projections.stationHealth(this.#visits, this.config.config, now);
  }

  bottlenecks(now: Date): StationHealth[] {
    return projections.bottlenecks(this.#visits, this.config.config, now);
  }

  pulse(now: Date): ClinicPulse {
    return projections.pulse(this.#visits, this.config.config, now);
  }

  longestWaiting(now: Date): LongestWaiting | null {
    return projections.longestWaiting(this.#visits, this.config.config, now);
  }

  workloads(): StaffWorkload[] {
    return projections.workloads(this.#visits, this.config.config);
  }

  // ----------------------------------------------------------------- actions

  /**
   * Admits a patient.
   *
   * The tracking token comes back once and is handed to the caller for the QR
   * code. It is never stored here: the store keeps clinic state, and a
   * credential kept in memory alongside it is a credential that reaches
   * anything holding a reference to the store.
   */
  async admit(patient: {
    patientName: string;
    hospitalNumber?: string;
    phone?: string;
    priority?: string;
  }): Promise<ActionResult & { trackingToken?: string; visit?: Visit }> {
    try {
      const response = await this.api.admit(patient, this.#key());
      const visit = visitFromWire(response.visit.state, this.deps);
      this.#replace(visit);
      return { ok: true, trackingToken: response.trackingToken, visit };
    } catch (error) {
      return fail(messageFor(error));
    }
  }

  /**
   * Calls the next patient in line.
   *
   * The station's queue order is the domain's, computed from what the server
   * returned, so the browser chooses *which* patient. Whether that patient may
   * be called is still the aggregate's decision, made server-side.
   */
  async callNext(stationId: StationId, _userId: UserId): Promise<ActionResult> {
    const worklist = this.worklist(stationId);
    if (worklist.current) {
      return fail(
        `${worklist.current.patientName} is still at this station. Complete or route them first.`,
      );
    }
    const next = worklist.waiting[0];
    if (next === undefined) return fail("Nobody is waiting at this station.");
    return this.#act((key) => this.api.call(next.visitId, key));
  }

  recall(visitId: VisitId, _userId: UserId): Promise<ActionResult> {
    return this.#act((key) => this.api.recall(visitId, key));
  }

  startService(visitId: VisitId, _userId: UserId): Promise<ActionResult> {
    return this.#act((key) => this.api.start(visitId, key));
  }

  skip(visitId: VisitId, _reason: string | null, _userId: UserId): Promise<ActionResult> {
    return this.#act((key) => this.api.skip(visitId, key));
  }

  complete(visitId: VisitId, _userId: UserId): Promise<ActionResult> {
    return this.#act((key) => this.api.complete(visitId, key));
  }

  cancel(visitId: VisitId, _userId: UserId): Promise<ActionResult> {
    return this.#act((key) => this.api.cancel(visitId, key));
  }

  /**
   * Routes a visit onward.
   *
   * Whether the destination is on the workflow is decided by the domain's
   * `resolveRoute` and *declared* to the server, which refuses an off-workflow
   * route without the permission for it. The browser is stating an intention,
   * not granting itself one.
   */
  async route(
    visitId: VisitId,
    toStationId: StationId,
    _userId: UserId,
  ): Promise<ActionResult> {
    const visit = this.find(visitId);
    const workflow = this.config.defaultWorkflow();
    if (visit === undefined) return fail("That visit is no longer open.");
    if (workflow === undefined) return fail("This hospital has no workflow configured.");

    let decision;
    try {
      decision = resolveRoute({ workflow, visit, requestedStationId: toStationId });
    } catch (error) {
      // The domain refuses a route from a visit that is not at a station, and
      // a route to the station it is already at. Both are the same answer a
      // server-side attempt would give; asking first saves a round trip.
      return fail(
        error instanceof Error ? error.message : "That visit cannot be routed there.",
      );
    }

    if (decision.kind === "complete") {
      return fail("That visit has reached the end of its workflow.");
    }

    return this.#act((key) =>
      this.api.route(visitId, decision.toStationId, decision.followedWorkflow, key),
    );
  }

  async #act(send: (key: string) => Promise<{ visit: { state: unknown } }>): Promise<ActionResult> {
    try {
      const response = await send(this.#key());
      this.#replace(
        visitFromWire(response.visit.state as Parameters<typeof visitFromWire>[0], this.deps),
      );
      return OK;
    } catch (error) {
      return fail(messageFor(error));
    }
  }

  /**
   * One key per logical action.
   *
   * Generated here rather than by the transport, so a caller that retries the
   * same action reuses it and the server recognises the second attempt as the
   * same intent rather than a new one.
   */
  #key(): string {
    return this.deps.ids.next();
  }

  #replace(visit: Visit): void {
    const index = this.#visits.findIndex((candidate) => candidate.id === visit.id);
    if (index === -1) this.#visits = [visit, ...this.#visits];
    else this.#visits = this.#visits.map((current, at) => (at === index ? visit : current));
    this.#commit();
  }

  #commit(): void {
    this.#version += 1;
    this.#heartbeat += 1;
    for (const listener of this.#listeners) listener();
  }
}
