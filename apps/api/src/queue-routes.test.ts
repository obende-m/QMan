/**
 * The queue and admission endpoints, over HTTP, without a database.
 *
 * The integration suite covers the same routes against PostgreSQL. This one
 * exists so the authorization and integrity rules are checked on every run —
 * including machines with no database — and so each rule has a test named for
 * the failure it prevents.
 *
 * The visit store is in memory but behaves like the real one where it matters:
 * every read returns an independent copy, writes are version-checked, and every
 * lookup is scoped to the caller's organization.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  UserId,
  Visit,
  visitFromWire,
  visitToWire,
  type BranchId,
  type EventQuery,
  type EventRecord,
  type HospitalConfiguration,
  type JourneyCode,
  type Permission,
  type Session,
  type StationId,
  type VisitId,
  type VisitWire,
} from "@qman/domain";
import {
  ConcurrentModificationError,
  type ClosureCriteria,
  type ConfigurationRepository,
  type EventRepository,
  type IdempotencyClaim,
  type IdempotencyRepository,
  type NewEvent,
  type TicketAllocator,
  type VisitRepository,
} from "@qman/persistence";
import type { AuthService, ResolvedSession } from "./auth.js";
import { BRANCH, HOSPITAL, ORIGIN, STATION, WORKFLOW, configuration, fakeOrganizations } from "./config-fixtures.js";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, buildServer } from "./server.js";
import { silentLogger } from "./logging.js";
import { EventStream } from "./stream.js";

const OTHER_HOSPITAL = "99999999-9999-9999-9999-999999999999";
const OTHER_BRANCH = "33333333-3333-3333-3333-333333333333";
const LAB = "55555555-5555-5555-5555-555555555555";
const PHARMACY = "77777777-7777-7777-7777-777777777777";
const XRAY = "88888888-8888-8888-8888-888888888888";

const NOW = new Date("2026-03-09T09:00:00Z");

let idCounter = 0;
function uuid(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}
const deps = { clock: { now: () => NOW }, ids: { next: uuid } };

/**
 * Consultation → Laboratory → Pharmacy, with an X-ray station that no workflow
 * includes, and the Laboratory able to send patients back to Consultation.
 */
function threeStageConfiguration(): HospitalConfiguration {
  const base = configuration();
  const station = base.stations[0]!;
  return {
    ...base,
    branches: [
      ...base.branches,
      { id: OTHER_BRANCH, name: "Annex", code: "ANX", isDefault: false },
    ],
    stations: [
      station,
      { ...station, id: LAB, name: "Laboratory", code: "LAB", queueNumber: { template: "L-{n:3}", reset: "daily" } },
      { ...station, id: PHARMACY, name: "Pharmacy", code: "PHA", queueNumber: { template: "P-{n:3}", reset: "daily" } },
      { ...station, id: XRAY, name: "X-ray", code: "XRY", queueNumber: { template: "X-{n:3}", reset: "daily" } },
    ],
    workflows: [
      {
        ...base.workflows[0]!,
        stages: [
          { id: "s1", stationId: STATION, sequence: 1, isRequired: true, allowSkip: false, allowRepeat: true, branchesTo: [] },
          { id: "s2", stationId: LAB, sequence: 2, isRequired: true, allowSkip: false, allowRepeat: false, branchesTo: [] },
          { id: "s3", stationId: PHARMACY, sequence: 3, isRequired: true, allowSkip: false, allowRepeat: false, branchesTo: [] },
        ],
      },
    ],
  } as unknown as HospitalConfiguration;
}

// ─────────────────────────────────────────────────────────────── fakes

interface StoredVisit {
  hospitalId: string;
  wire: VisitWire;
  version: number;
  tokenHash: string | null;
}

class MemoryVisits implements VisitRepository {
  readonly rows = new Map<string, StoredVisit>();
  readonly events: NewEvent[] = [];
  readonly #versions = new WeakMap<Visit, number>();
  /** Which organization owns each branch, as the join through `branches` would say. */
  readonly branchOwners = new Map<string, string>([
    [BRANCH, HOSPITAL],
    [OTHER_BRANCH, HOSPITAL],
  ]);

  /** When set, saves wait until this many loads have happened: a forced race. */
  #barrier: { loads: number; needed: number; release: () => void; ready: Promise<void> } | null = null;

  holdSavesUntilLoads(needed: number): void {
    let release = () => {};
    const ready = new Promise<void>((resolve) => (release = resolve));
    this.#barrier = { loads: 0, needed, release, ready };
  }

  #load(row: StoredVisit): Visit {
    if (this.#barrier) {
      this.#barrier.loads += 1;
      if (this.#barrier.loads >= this.#barrier.needed) this.#barrier.release();
    }
    const visit = visitFromWire(row.wire, deps);
    this.#versions.set(visit, row.version);
    return visit;
  }

  async find(hospitalId: string, id: VisitId): Promise<Visit | null> {
    const row = this.rows.get(id);
    return row && row.hospitalId === hospitalId ? this.#load(row) : null;
  }
  async findByJourneyCode(branchId: BranchId, code: JourneyCode): Promise<Visit | null> {
    for (const row of this.rows.values()) {
      if (row.wire.branchId === branchId && row.wire.journeyCode === code && row.wire.closedAt === null) {
        return this.#load(row);
      }
    }
    return null;
  }
  async openAtStation(hospitalId: string, stationId: StationId): Promise<Visit[]> {
    return [...this.rows.values()]
      .filter((row) => row.hospitalId === hospitalId)
      .map((row) => this.#load(row))
      .filter((visit) => visit.currentStationId === stationId);
  }
  async activeInBranch(hospitalId: string, branchId: BranchId): Promise<Visit[]> {
    return [...this.rows.values()]
      .filter((row) => row.hospitalId === hospitalId && row.wire.branchId === branchId && row.wire.closedAt === null)
      .map((row) => this.#load(row));
  }
  async findByTrackingToken(tokenHash: string): Promise<Visit | null> {
    for (const row of this.rows.values()) {
      if (row.tokenHash === tokenHash && row.wire.closedAt === null) return this.#load(row);
    }
    return null;
  }
  async save(visit: Visit, events: readonly NewEvent[], options: { trackingTokenHash?: string } = {}): Promise<void> {
    if (this.#barrier) await this.#barrier.ready;
    const known = this.#versions.get(visit);
    const existing = this.rows.get(visit.id);
    if (known === undefined ? existing !== undefined : existing?.version !== known) {
      throw new ConcurrentModificationError(visit.id);
    }
    const hospitalId = this.branchOwners.get(visit.branchId);
    if (hospitalId === undefined) throw new Error("foreign key violation: unknown branch");
    const version = known === undefined ? 0 : known + 1;
    this.rows.set(visit.id, {
      hospitalId,
      wire: visitToWire(visit, { includeIdentity: true }),
      version,
      tokenHash: options.trackingTokenHash ?? existing?.tokenHash ?? null,
    });
    this.#versions.set(visit, version);
    this.events.push(...events);
  }
  async isJourneyCodeTaken(): Promise<boolean> {
    return false;
  }
  async reissueTrackingToken(hospitalId: string, id: VisitId, tokenHash: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.hospitalId !== hospitalId || row.wire.closedAt !== null) return false;
    row.tokenHash = tokenHash;
    return true;
  }
  async awaitingClosure(_criteria: ClosureCriteria): Promise<Array<{ hospitalId: string; visit: Visit }>> {
    return [];
  }
}

class MemoryEvents implements EventRepository {
  readonly queries: Array<{ hospitalId: string; query: EventQuery }> = [];
  async append(): Promise<void> {}
  async query(hospitalId: string, query: EventQuery): Promise<EventRecord[]> {
    this.queries.push({ hospitalId, query });
    return [];
  }
  async forVisit(): Promise<EventRecord[]> {
    return [];
  }
}

class MemoryIdempotency implements IdempotencyRepository {
  readonly rows = new Map<string, { fingerprint: string; status: number | null; response: unknown }>();
  async claim(hospitalId: string, key: string, fingerprint: string): Promise<IdempotencyClaim> {
    const id = `${hospitalId}:${key}`;
    const row = this.rows.get(id);
    if (row === undefined) {
      this.rows.set(id, { fingerprint, status: null, response: null });
      return { outcome: "claimed" };
    }
    if (row.fingerprint !== fingerprint) return { outcome: "mismatch" };
    if (row.status === null) return { outcome: "in_flight" };
    return { outcome: "replay", statusCode: row.status, response: row.response };
  }
  async complete(hospitalId: string, key: string, status: number, response: unknown): Promise<void> {
    const row = this.rows.get(`${hospitalId}:${key}`);
    if (row) Object.assign(row, { status, response: JSON.parse(JSON.stringify(response)) });
  }
  async release(hospitalId: string, key: string): Promise<void> {
    const id = `${hospitalId}:${key}`;
    if (this.rows.get(id)?.status === null) this.rows.delete(id);
  }
  async prune(): Promise<number> {
    return 0;
  }
}

class Counter implements TicketAllocator {
  readonly issued: string[] = [];
  #n = new Map<string, number>();
  async next(stationId: StationId, periodKey: string): Promise<number> {
    const key = `${stationId}:${periodKey}`;
    const value = (this.#n.get(key) ?? 0) + 1;
    this.#n.set(key, value);
    this.issued.push(stationId);
    return value;
  }
}

const ALL: Permission[] = [
  "visit.create",
  "visit.cancel",
  "visit.view_identity",
  "visit.escalate",
  "queue.call",
  "queue.recall",
  "queue.skip",
  "queue.start",
  "queue.complete",
  "queue.route",
  "queue.route_off_workflow",
  "reports.view",
  "admin.settings",
];

interface Caller {
  token: string;
  hospitalId?: string;
  branchId?: string | null;
  permissions?: Permission[];
}

/** Sessions keyed by token: the guard asks for nothing else. */
function fakeAuth(callers: Caller[]): AuthService {
  const byToken = new Map(callers.map((c) => [c.token, c]));
  return {
    async resolve(token: string): Promise<ResolvedSession | null> {
      const caller = byToken.get(token);
      if (caller === undefined) return null;
      const branchId = (caller.branchId ?? null) as BranchId | null;
      return {
        hospitalId: caller.hospitalId ?? HOSPITAL,
        session: { id: `session-${caller.token}`, userId: UserId(`user-${caller.token}`), branchId } as unknown as Session,
        user: {
          account: {
            id: UserId(`aaaaaaaa-0000-4000-8000-${caller.token.padStart(12, "0").slice(-12)}`),
            displayName: caller.token,
            username: caller.token,
            roleId: "role",
            branchIds: [],
            providerId: "local",
            enabled: true,
          },
          permissions: caller.permissions ?? ALL,
          branchId,
        },
      } as unknown as ResolvedSession;
    },
  } as unknown as AuthService;
}

function harness(callers: Caller[], config: HospitalConfiguration = threeStageConfiguration()) {
  const visits = new MemoryVisits();
  const events = new MemoryEvents();
  const idempotency = new MemoryIdempotency();
  const allocator = new Counter();
  const stream = new EventStream();
  let tokenCounter = 0;
  const configurationRepository: ConfigurationRepository = {
    load: async (hospitalId) => (hospitalId === HOSPITAL ? config : null),
    loadRoles: async () => [],
  };

  const app = buildServer({
    auth: fakeAuth(callers),
    organizations: fakeOrganizations(),
    secureCookies: true,
    allowedOrigins: [ORIGIN],
    logger: silentLogger(),
    now: () => NOW,
    stream,
    queue: {
      visits,
      events,
      idempotency: { repository: idempotency, logger: silentLogger(), now: () => NOW },
      admission: {
        visits,
        allocator,
        deps,
        configuration: configurationRepository,
        newTrackingToken: () => `tracking-token-${(tokenCounter += 1)}-${"x".repeat(24)}`,
        hashToken: (token) => `hash(${token})`,
      },
    },
  });

  const request = (
    caller: string,
    method: "GET" | "POST",
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE}=${caller}; ${CSRF_COOKIE}=csrf`,
        [CSRF_HEADER]: "csrf",
        ...headers,
      },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  return { app, visits, events, idempotency, allocator, stream, request };
}

type Harness = ReturnType<typeof harness>;

async function admitOne(h: Harness, caller = "reception", body: Record<string, unknown> = {}) {
  const response = await h.request(caller, "POST", "/api/v1/visits", {
    patientName: "Amara Okafor",
    hospitalNumber: "HN-4471",
    phone: "+2348012345678",
    ...body,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { visit: { id: string; state: VisitWire }; trackingToken: string };
}

// ─────────────────────────────────────────────────────────────── suites

describe("admission", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness([
      { token: "reception" },
      { token: "clerk", permissions: ["visit.create", "queue.call"] },
    ]);
  });

  it("admits a patient into the first station of the default workflow", async () => {
    const { visit, trackingToken } = await admitOne(h);
    expect(visit.state.status).toBe("queued");
    expect(visit.state.queueEntries[0]!.stationId).toBe(STATION);
    expect(trackingToken.length).toBeGreaterThan(20);
    expect(h.visits.rows.get(visit.id)!.tokenHash).toBe(`hash(${trackingToken})`);
  });

  it("refuses a priority outside the recognised set before writing anything", async () => {
    const response = await h.request("reception", "POST", "/api/v1/visits", {
      patientName: "Amara Okafor",
      priority: "urgent!!",
    });
    expect(response.statusCode).toBe(422);
    expect(h.visits.rows.size).toBe(0);
    expect(h.allocator.issued).toEqual([]);
  });

  it("refuses a raised priority to a caller who may not escalate", async () => {
    const response = await h.request("clerk", "POST", "/api/v1/visits", {
      patientName: "Amara Okafor",
      priority: "emergency",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().permission).toBe("visit.escalate");
    expect(h.visits.rows.size).toBe(0);
  });

  it("refuses identity fields of the wrong type rather than discarding them", async () => {
    const response = await h.request("reception", "POST", "/api/v1/visits", {
      patientName: "Amara Okafor",
      hospitalNumber: 4471,
    });
    expect(response.statusCode).toBe(422);
  });

  it("refuses a workflow that does not exist as a client error, not a fault", async () => {
    const response = await h.request("reception", "POST", "/api/v1/visits", {
      patientName: "Amara Okafor",
      workflowId: "not-a-workflow",
    });
    expect(response.statusCode).toBe(422);
  });

  it("keeps the patient's identity out of every event it records", async () => {
    await admitOne(h);
    const text = JSON.stringify(h.visits.events);
    expect(text).not.toContain("Amara");
    expect(text).not.toContain("HN-4471");
    expect(text).not.toContain("2348012345678");
  });

  describe("retried", () => {
    it("admits nobody twice, and answers with a fresh token that works", async () => {
      const headers = { "idempotency-key": "admit-1" };
      const body = { patientName: "Amara Okafor" };
      const first = await h.request("reception", "POST", "/api/v1/visits", body, headers);
      const second = await h.request("reception", "POST", "/api/v1/visits", body, headers);

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.headers["idempotent-replay"]).toBe("true");
      expect(h.visits.rows.size).toBe(1);
      // One ticket, not two.
      expect(h.allocator.issued).toHaveLength(1);
      expect(second.json().visit.id).toBe(first.json().visit.id);

      // The first token was lost with the response that carried it; only the
      // reissued one resolves now.
      const row = h.visits.rows.get(first.json().visit.id)!;
      expect(row.tokenHash).toBe(`hash(${second.json().trackingToken})`);
      expect(second.json().trackingToken).not.toBe(first.json().trackingToken);
    });

    it("never stores a tracking token or a patient's identity in the retry record", async () => {
      await h.request("reception", "POST", "/api/v1/visits", { patientName: "Amara Okafor" }, {
        "idempotency-key": "admit-2",
      });
      const stored = JSON.stringify([...h.idempotency.rows.values()]);
      expect(stored).not.toContain("tracking-token");
      expect(stored).not.toContain("Amara");
    });
  });
});

describe("identity", () => {
  it("is withheld from a caller without visit.view_identity", async () => {
    const h = harness([
      { token: "reception" },
      { token: "manager", permissions: ["reports.view", "queue.call"] },
    ]);
    await admitOne(h);

    for (const url of [`/api/v1/branches/${BRANCH}/visits`, `/api/v1/stations/${STATION}/queue`]) {
      const response = await h.request("manager", "GET", url);
      expect(response.statusCode).toBe(200);
      const text = response.body;
      expect(text).not.toContain("Amara");
      expect(text).not.toContain("HN-4471");
      expect(text).not.toContain("2348012345678");
      expect(response.json().visits[0].state.identityWithheld).toBe(true);
    }
  });

  it("is included for a caller who holds visit.view_identity", async () => {
    const h = harness([{ token: "reception" }]);
    await admitOne(h);
    const response = await h.request("reception", "GET", `/api/v1/branches/${BRANCH}/visits`);
    expect(response.json().visits[0].state.patient.name).toBe("Amara Okafor");
  });

  it("is withheld from the action response too, not only from lists", async () => {
    const h = harness([
      { token: "reception" },
      { token: "caller", permissions: ["queue.call"] },
    ]);
    const { visit } = await admitOne(h);
    const response = await h.request("caller", "POST", `/api/v1/visits/${visit.id}/call`);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("Amara");
  });
});

describe("routing", () => {
  let h: Harness;
  let visitId: string;
  beforeEach(async () => {
    h = harness([
      { token: "reception" },
      { token: "nurse", permissions: ["queue.call", "queue.start", "queue.route"] },
    ]);
    visitId = (await admitOne(h)).visit.id;
    await h.request("reception", "POST", `/api/v1/visits/${visitId}/call`);
    await h.request("reception", "POST", `/api/v1/visits/${visitId}/start`);
  });

  it("routes along the workflow", async () => {
    const response = await h.request("nurse", "POST", `/api/v1/visits/${visitId}/route`, { stationId: LAB });
    expect(response.statusCode).toBe(200);
    const routed = h.visits.events.find((e) => e.type === "visit.routed")!;
    expect(routed.payload["followedWorkflow"]).toBe(true);
  });

  it("refuses a route outside the workflow however the client describes it", async () => {
    // The body claims the route follows the workflow. It does not: X-ray is in
    // no stage. The claim used to be believed.
    const response = await h.request("nurse", "POST", `/api/v1/visits/${visitId}/route`, {
      stationId: XRAY,
      followedWorkflow: true,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().permission).toBe("queue.route_off_workflow");
    expect(h.visits.events.some((e) => e.type === "visit.routed")).toBe(false);
    // A refused route consumes no ticket number.
    expect(h.allocator.issued.filter((s) => s === XRAY)).toEqual([]);
  });

  it("records an authorised override as an override, whatever the client says", async () => {
    const response = await h.request("reception", "POST", `/api/v1/visits/${visitId}/route`, {
      stationId: XRAY,
      followedWorkflow: true,
    });
    expect(response.statusCode).toBe(200);
    const routed = h.visits.events.find((e) => e.type === "visit.routed")!;
    expect(routed.payload["followedWorkflow"]).toBe(false);
  });

  it("refuses a destination that is disabled", async () => {
    const config = threeStageConfiguration();
    const disabled = {
      ...config,
      stations: config.stations.map((s) => (s.id === LAB ? { ...s, enabled: false } : s)),
    } as HospitalConfiguration;
    const local = harness([{ token: "reception" }], disabled);
    const id = (await admitOne(local)).visit.id;
    await local.request("reception", "POST", `/api/v1/visits/${id}/call`);
    const response = await local.request("reception", "POST", `/api/v1/visits/${id}/route`, { stationId: LAB });
    expect(response.statusCode).toBe(422);
  });

  it("refuses a destination that does not exist", async () => {
    const response = await h.request("reception", "POST", `/api/v1/visits/${visitId}/route`, {
      stationId: "12345678-1234-4234-8234-123456789012",
    });
    expect(response.statusCode).toBe(422);
  });
});

describe("transitions", () => {
  let h: Harness;
  let visitId: string;
  beforeEach(async () => {
    h = harness([
      { token: "reception" },
      { token: "caller", permissions: ["queue.call"] },
    ]);
    visitId = (await admitOne(h)).visit.id;
  });

  it("answers an illegal transition with 409, not a server error", async () => {
    // Service cannot start before the patient is called.
    const response = await h.request("reception", "POST", `/api/v1/visits/${visitId}/start`);
    expect(response.statusCode).toBe(409);
  });

  it("does not turn a second call into a recall", async () => {
    expect((await h.request("caller", "POST", `/api/v1/visits/${visitId}/call`)).statusCode).toBe(200);
    const again = await h.request("caller", "POST", `/api/v1/visits/${visitId}/call`);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("VISIT_ALREADY_CALLED");
  });

  it("requires queue.recall to recall", async () => {
    await h.request("caller", "POST", `/api/v1/visits/${visitId}/call`);
    const response = await h.request("caller", "POST", `/api/v1/visits/${visitId}/recall`);
    expect(response.statusCode).toBe(403);
    expect((await h.request("reception", "POST", `/api/v1/visits/${visitId}/recall`)).statusCode).toBe(200);
  });

  it("refuses to recall a patient who was never called", async () => {
    const response = await h.request("reception", "POST", `/api/v1/visits/${visitId}/recall`);
    expect(response.statusCode).toBe(409);
  });

  it("answers a malformed id as not found rather than as a fault", async () => {
    const response = await h.request("reception", "POST", "/api/v1/visits/not-a-uuid/call");
    expect(response.statusCode).toBe(404);
  });

  it("changes priority only with visit.escalate, and records it", async () => {
    const refused = await h.request("caller", "POST", `/api/v1/visits/${visitId}/priority`, { priority: "high" });
    expect(refused.statusCode).toBe(403);
    const invalid = await h.request("reception", "POST", `/api/v1/visits/${visitId}/priority`, { priority: "asap" });
    expect(invalid.statusCode).toBe(422);
    const changed = await h.request("reception", "POST", `/api/v1/visits/${visitId}/priority`, { priority: "high" });
    expect(changed.statusCode).toBe(200);
    expect(h.visits.events.some((e) => e.type === "visit.priority_changed")).toBe(true);
  });
});

describe("concurrency", () => {
  it("lets one of two simultaneous actions win and tells the other", async () => {
    const h = harness([{ token: "reception" }]);
    const { visit } = await admitOne(h);

    // Both requests load the visit before either writes, which is the race.
    h.visits.holdSavesUntilLoads(2);
    const [first, second] = await Promise.all([
      h.request("reception", "POST", `/api/v1/visits/${visit.id}/call`),
      h.request("reception", "POST", `/api/v1/visits/${visit.id}/cancel`),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    // Exactly one transition's events were kept.
    const types = h.visits.events.map((e) => e.type);
    expect(types.filter((t) => t === "visit.called" || t === "visit.cancelled")).toHaveLength(1);
  });
});

describe("tenancy and branches", () => {
  it("does not let another organization's staff act on a visit", async () => {
    const h = harness([
      { token: "reception" },
      { token: "intruder", hospitalId: OTHER_HOSPITAL },
    ]);
    const { visit } = await admitOne(h);
    const response = await h.request("intruder", "POST", `/api/v1/visits/${visit.id}/call`);
    expect(response.statusCode).toBe(404);
    const read = await h.request("intruder", "GET", `/api/v1/visits/${visit.id}`);
    expect(read.statusCode).toBe(404);
  });

  it("keeps branch-pinned staff out of another branch's visits", async () => {
    const h = harness([
      { token: "reception" },
      { token: "annex", branchId: OTHER_BRANCH },
    ]);
    const { visit } = await admitOne(h);

    expect((await h.request("annex", "POST", `/api/v1/visits/${visit.id}/call`)).statusCode).toBe(403);
    expect((await h.request("annex", "GET", `/api/v1/branches/${BRANCH}/visits`)).statusCode).toBe(403);
    const queue = await h.request("annex", "GET", `/api/v1/stations/${STATION}/queue`);
    expect(queue.json().visits).toEqual([]);
  });

  it("scopes a branch-pinned caller's event reads to their branch", async () => {
    const h = harness([{ token: "annex", branchId: OTHER_BRANCH }]);
    expect((await h.request("annex", "GET", `/api/v1/events?branchId=${BRANCH}`)).statusCode).toBe(403);
    await h.request("annex", "GET", "/api/v1/events");
    expect(h.events.queries.at(-1)!.query.branchId).toBe(OTHER_BRANCH);
  });

  it("keeps the audit log from a caller with no administrative permission", async () => {
    const h = harness([{ token: "manager", permissions: ["reports.view"] }]);
    const refused = await h.request("manager", "GET", "/api/v1/events?category=security");
    expect(refused.statusCode).toBe(403);
    await h.request("manager", "GET", "/api/v1/events");
    expect(h.events.queries.at(-1)!.query.categories).toEqual(["operational"]);
  });

  it("rejects a malformed page size rather than passing NaN to the database", async () => {
    const h = harness([{ token: "reception" }]);
    expect((await h.request("reception", "GET", "/api/v1/events?limit=abc")).statusCode).toBe(400);
  });
});
