/**
 * Test fixtures for the API-backed stores.
 *
 * One builder, used by every suite. It stands up a hospital and a set of
 * visits, serves them through a stubbed `fetch`, and hands back loaded stores.
 *
 * Stubbing the transport rather than the stores is deliberate. The stores are
 * what the migration replaced, so a test that mocked them would prove nothing
 * about the thing that changed — and the wire format, the rehydration and the
 * typed failures would go uncovered. Going through `fetch` means a suite
 * exercises `ApiClient`, `visitFromWire` and `Visit.rehydrate` on the way to
 * whatever it was actually asserting.
 *
 * Visits are built by driving the real aggregate — create, enqueue, call,
 * start, route — so a fixture that describes an impossible clinic throws while
 * being built rather than rendering something the domain would never produce.
 */
import {
  DEFAULT_TICKET_TEMPLATE,
  hasBlockingProblems,
  validateHospitalConfiguration,
  validateRoles,
  QUEUE_NUMBER_PRESETS,
  UserId,
  Visit,
  visitToWire,
  type BranchId,
  type DisplayBoardConfig,
  type HospitalConfiguration,
  type Permission,
  type RoleConfig,
  type StationConfig,
  type StationId,
  type Workflow,
} from "@qman/domain";
import type { AuthStore } from "../data/auth-store.js";
import type { ClinicStore } from "../data/clinic-store.js";
import type { ConfigStore } from "../data/config-store.js";
import type { StreamEventLike } from "../data/operations-store.js";
import { stores } from "../data/runtime-stores.js";

export const HOSPITAL_ID = "11111111-1111-1111-1111-111111111111";
export const BRANCH_ID = "22222222-2222-2222-2222-222222222222" as BranchId;

/** Stable station ids, so a suite can assert against a known station. */
export const STATION_IDS = {
  reception: "33333333-0000-0000-0000-000000000001" as StationId,
  vitals: "33333333-0000-0000-0000-000000000002" as StationId,
  consultation: "33333333-0000-0000-0000-000000000003" as StationId,
  laboratory: "33333333-0000-0000-0000-000000000004" as StationId,
  pharmacy: "33333333-0000-0000-0000-000000000005" as StationId,
} as const;

export const USER_ID = UserId("44444444-0000-0000-0000-000000000001");

function station(
  id: StationId,
  name: string,
  code: string,
  overrides: Partial<StationConfig> = {},
): StationConfig {
  return {
    id,
    name,
    code,
    room: null,
    staffing: 1,
    serviceEstimateMillis: 10 * 60_000,
    sla: { targetWaitMillis: 30 * 60_000, saturationPoint: 10 },
    queueNumber: QUEUE_NUMBER_PRESETS.numeric(),
    isPublic: true,
    enabled: true,
    ...overrides,
  } as StationConfig;
}

/**
 * A hospital that passes the domain's own validation.
 *
 * Five stations, one workflow through them, one board and the default ticket
 * template — the smallest configuration in which a patient can actually be
 * admitted, called and routed.
 */
export function testConfiguration(
  overrides: Partial<HospitalConfiguration> = {},
): HospitalConfiguration {
  const stations = [
    station(STATION_IDS.reception, "Reception", "REC", { isPublic: false }),
    station(STATION_IDS.vitals, "Vitals", "VIT", { room: "Room 3" }),
    station(STATION_IDS.consultation, "Consultation", "OPD", {
      room: "Room 12",
      staffing: 3,
      queueNumber: QUEUE_NUMBER_PRESETS.sequential("A"),
    }),
    station(STATION_IDS.laboratory, "Laboratory", "LAB", {
      room: "Lab Wing",
      queueNumber: QUEUE_NUMBER_PRESETS.sequential("L"),
    }),
    station(STATION_IDS.pharmacy, "Pharmacy", "PHR", {
      queueNumber: QUEUE_NUMBER_PRESETS.sequential("P"),
    }),
  ];

  const workflow = {
    id: "55555555-0000-0000-0000-000000000001",
    branchId: BRANCH_ID,
    name: "General Outpatient",
    isDefault: true,
    stages: [
      stage(1, STATION_IDS.reception),
      stage(2, STATION_IDS.vitals),
      stage(3, STATION_IDS.consultation, { branchesTo: [STATION_IDS.laboratory] }),
      stage(4, STATION_IDS.laboratory, {
        isRequired: false,
        branchesTo: [STATION_IDS.consultation],
      }),
      stage(5, STATION_IDS.pharmacy, { isRequired: false }),
    ],
  } as unknown as Workflow;

  const board: DisplayBoardConfig = {
    id: "board-main",
    name: "Main Waiting Area",
    stationIds: [STATION_IDS.consultation, STATION_IDS.laboratory, STATION_IDS.pharmacy],
    waitingToShow: 4,
    namePolicy: "ticket_only",
    showEstimatedWait: true,
    showRoom: true,
  };

  return {
    profile: {
      id: HOSPITAL_ID,
      name: "Ikeja General Hospital",
      code: "IGH",
      timezone: "Africa/Lagos",
      supportPhone: "+234 800 000 0000",
      brandColor: "#003ec7",
    },
    branches: [{ id: BRANCH_ID, name: "Main Branch", code: "MAIN", isDefault: true }],
    stations,
    workflows: [workflow],
    displayBoards: [board],
    ticketTemplates: [DEFAULT_TICKET_TEMPLATE],
    defaults: { namePolicy: "ticket_only", ticketTemplateId: DEFAULT_TICKET_TEMPLATE.id },
    ...overrides,
  } as unknown as HospitalConfiguration;
}

function stage(
  sequence: number,
  stationId: StationId,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `stage-${sequence}`,
    stationId,
    sequence,
    isRequired: true,
    allowSkip: false,
    allowRepeat: false,
    branchesTo: [],
    ...overrides,
  };
}

export const TEST_ROLES: RoleConfig[] = [
  {
    id: "role-admin",
    name: "Administrator",
    description: "Full access",
    permissions: ["admin.users", "admin.stations", "admin.workflows"] as Permission[],
    isSystem: true,
  },
];

/** Every permission, so a suite asserting a screen is not blocked by a guard. */
export const ALL_TEST_PERMISSIONS: Permission[] = [
  "visit.create",
  "visit.cancel",
  "visit.view_identity",
  "queue.call",
  "queue.recall",
  "queue.skip",
  "queue.start",
  "queue.complete",
  "queue.route",
  "queue.route_off_workflow",
  "visit.escalate",
  "reports.view",
  "reports.export",
  "admin.stations",
  "admin.workflows",
  "admin.display_boards",
  "admin.users",
  "admin.settings",
];

export interface VisitPlan {
  readonly name: string;
  readonly hospitalNumber?: string;
  readonly priority?: "normal" | "high" | "emergency";
  /** Stations the visit has passed through, in order. The last is current. */
  readonly path: readonly StationId[];
  /** Whether the patient at the final station has been called and started. */
  readonly state?: "waiting" | "called" | "in_progress" | "completed";
  /** Minutes before now that the visit was admitted. */
  readonly arrivedMinutesAgo?: number;
}

let sequence = 0;

/** Four symbols from the domain's own alphabet. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function journeyCodeBody(n: number): string {
  let value = n + 1;
  let body = "";
  for (let i = 0; i < 4; i += 1) {
    body = CODE_ALPHABET[value % CODE_ALPHABET.length] + body;
    value = Math.floor(value / CODE_ALPHABET.length) + 7;
  }
  return body;
}

/**
 * Builds a visit by driving the aggregate, exactly as the server would.
 *
 * A fixture that describes an impossible journey therefore fails while being
 * built, rather than producing a screen the domain would never have allowed.
 */
export function buildVisit(plan: VisitPlan, now: Date): Visit {
  const admittedAt = new Date(now.getTime() - (plan.arrivedMinutesAgo ?? 20) * 60_000);
  let clock = admittedAt;
  const deps = {
    clock: { now: () => clock },
    ids: { next: () => `fixture-${(sequence += 1)}` },
  };

  const visit = Visit.create(
    {
      // The domain alphabet excludes I, L, O, U, 0 and 1, so a code built from
      // plain digits is rejected by parseJourneyCode and never resolves.
      journeyCode: `QM-${journeyCodeBody(sequence)}` as never,
      branchId: BRANCH_ID,
      workflowId: "55555555-0000-0000-0000-000000000001" as never,
      patient: {
        name: plan.name,
        hospitalNumber: plan.hospitalNumber ?? null,
        phone: null,
      },
      ...(plan.priority ? { priority: plan.priority } : {}),
    },
    deps,
  );

  const path = plan.path;
  const ticket = (stationId: StationId, ordinal: number) => ({
    ordinal,
    label: `${ticketPrefix(stationId)}-${String(ordinal).padStart(3, "0")}`,
    periodKey: "fixture",
  });

  path.forEach((stationId, index) => {
    const ordinal = index + 1;
    if (index === 0) {
      visit.enqueue(stationId, ticket(stationId, ordinal), { actorId: USER_ID });
    } else {
      visit.call(USER_ID, { actorId: USER_ID });
      visit.startService(USER_ID, { actorId: USER_ID });
      clock = new Date(clock.getTime() + 5 * 60_000);
      visit.routeTo(stationId, ticket(stationId, ordinal), {
        actorId: USER_ID,
        followedWorkflow: true,
      });
    }
  });

  const state = plan.state ?? "waiting";
  if (state === "called" || state === "in_progress" || state === "completed") {
    visit.call(USER_ID, { actorId: USER_ID });
  }
  if (state === "in_progress" || state === "completed") {
    visit.startService(USER_ID, { actorId: USER_ID });
  }
  if (state === "completed") {
    visit.complete({ actorId: USER_ID });
  }

  visit.pullEvents();
  return visit;
}

function ticketPrefix(stationId: StationId): string {
  if (stationId === STATION_IDS.consultation) return "A";
  if (stationId === STATION_IDS.laboratory) return "L";
  if (stationId === STATION_IDS.pharmacy) return "P";
  return "Q";
}

/** The clinic most suites want: a handful of patients spread across stations. */
export function defaultVisits(now = new Date()): Visit[] {
  return [
    buildVisit(
      { name: "Amara Okafor", hospitalNumber: "HN-4471", path: [STATION_IDS.consultation], state: "in_progress", arrivedMinutesAgo: 45 },
      now,
    ),
    /*
     * Queued at Vitals, which is stage 2 of the workflow. Consultation is
     * stage 3 and required, so this patient has a road ahead — which is what a
     * journey timeline is for. A patient queued at Consultation has only
     * optional stages left, and `journeySteps` lists no optional stage as
     * upcoming: telling someone they will be sent to the laboratory when they
     * may not be is worse than telling them nothing.
     */
    buildVisit({ name: "Tunde Bello", path: [STATION_IDS.vitals], arrivedMinutesAgo: 30 }, now),
    buildVisit({ name: "Ngozi Eze", path: [STATION_IDS.consultation], arrivedMinutesAgo: 18, priority: "high" }, now),
    buildVisit({ name: "Chidi Obi", path: [STATION_IDS.laboratory], arrivedMinutesAgo: 25 }, now),
    buildVisit({ name: "Fatima Yusuf", path: [STATION_IDS.laboratory], state: "called", arrivedMinutesAgo: 12 }, now),
    buildVisit({ name: "Emeka Nwosu", path: [STATION_IDS.pharmacy], arrivedMinutesAgo: 8 }, now),
    buildVisit({ name: "Grace Adeyemi", path: [STATION_IDS.vitals], arrivedMinutesAgo: 5, priority: "emergency" }, now),
    // A patient part-way through their journey, so a timeline has both a past
    // and a future, and one whose visit is finished.
    buildVisit(
      {
        name: "Bola Adewale",
        path: [STATION_IDS.vitals, STATION_IDS.consultation],
        arrivedMinutesAgo: 55,
      },
      now,
    ),
    buildVisit(
      {
        name: "Sade Johnson",
        path: [STATION_IDS.consultation],
        state: "completed",
        arrivedMinutesAgo: 70,
      },
      now,
    ),
  ];
}

export interface FixtureOptions {
  readonly configuration?: HospitalConfiguration;
  readonly visits?: Visit[];
  readonly roles?: RoleConfig[];
  readonly permissions?: readonly Permission[];
  readonly signedIn?: boolean;
}

/**
 * The server's event stream, as the fixture serves it.
 *
 * A successful action publishes here exactly as the API does, so a suite
 * asserting that calling a patient produced an announcement drives the same
 * path production does — action, server, stream, OperationsStore — rather than
 * publishing a browser event nothing produces any more.
 */
export interface FixtureStream {
  onEvent(listener: (event: StreamEventLike) => void): () => void;
}

export interface Fixture {
  readonly stream: FixtureStream;
  readonly config: ConfigStore;
  readonly clinic: ClinicStore;
  readonly auth: AuthStore;
  /** Every request the suite caused, for asserting what was sent. */
  readonly requests: Array<{ method: string; url: string; body: unknown }>;
  restore(): void;
}

/**
 * Stands up loaded stores over a stubbed transport.
 *
 * Writes are answered by echoing what the caller sent back through the same
 * shapes the server uses, so a suite that saves a station reads the saved
 * station afterwards without the fixture having to model the server's rules.
 */
export async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const configuration = options.configuration ?? testConfiguration();
  const visits = options.visits ?? defaultVisits();
  const roles = [...(options.roles ?? TEST_ROLES)];
  const permissions = options.permissions ?? ALL_TEST_PERMISSIONS;

  let current = configuration;
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  const streamListeners = new Set<(event: StreamEventLike) => void>();
  const stream: FixtureStream = {
    onEvent: (listener) => {
      streamListeners.add(listener);
      return () => streamListeners.delete(listener);
    },
  };

  /** Mirrors `describeEvent`: what the staff projection carries. */
  const publish = (visit: Visit, type: string, stationId: StationId | null): void => {
    const entry = visit.currentEntry;
    const event: StreamEventLike = {
      type,
      at: new Date().toISOString(),
      visitId: visit.id,
      actorId: USER_ID,
      correlationId: visit.journeyCode,
      stationId: stationId ?? entry?.stationId ?? null,
      queueLabel: entry?.queueLabel ?? null,
      summary: summaryFor(type, visit, current, stationId),
    };
    for (const listener of [...streamListeners]) listener(event);
  };

  const respond = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => "application/json" },
      json: async () => body,
    }) as unknown as Response;

  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body === undefined ? undefined : JSON.parse(init.body as string);
    requests.push({ method, url, body });

    if (url.endsWith("/api/v1/auth/me")) {
      if (options.signedIn === false) return respond(401, { error: "Not signed in." });
      return respond(200, { user: signedInUser(permissions) });
    }
    if (url.endsWith("/api/v1/auth/login")) {
      return respond(200, { user: signedInUser(permissions), csrfToken: "test-csrf" });
    }
    if (url.endsWith("/api/v1/auth/logout")) return respond(204, null);

    if (url.endsWith("/api/v1/config")) {
      return respond(200, { configuration: current, problems: [] });
    }
    if (url.endsWith("/api/v1/roles") && method === "GET") {
      return respond(200, { roles });
    }

    if (url.includes("/visits") && method === "GET") {
      return respond(200, { visits: visits.map((visit) => ({ state: visitToWire(visit) })) });
    }

    /**
     * Queue actions run against the real aggregate, exactly as the server does.
     *
     * A stub that returned a hand-written visit would let a suite assert a
     * transition the state machine forbids — which is the one thing these
     * tests exist to catch.
     */
    const action = url.match(/\/api\/v1\/visits\/([^/]+)\/(\w+)$/);
    if (action !== null && method === "POST") {
      const [, rawId, name] = action;
      const visit = visits.find((v) => v.id === decodeURIComponent(rawId!));
      if (visit === undefined) return respond(404, { error: "No such visit." });

      try {
        if (name === "call" || name === "recall") visit.call(USER_ID, { actorId: USER_ID });
        else if (name === "start") visit.startService(USER_ID, { actorId: USER_ID });
        else if (name === "skip") visit.skip({ actorId: USER_ID });
        else if (name === "complete") visit.complete({ actorId: USER_ID });
        else if (name === "cancel") visit.cancel({ actorId: USER_ID });
        else if (name === "route") {
          const to = (body as { stationId: string }).stationId as StationId;
          visit.routeTo(
            to,
            { ordinal: 1, label: "R-001", periodKey: "fixture" },
            { actorId: USER_ID, followedWorkflow: true },
          );
        } else {
          return respond(404, { error: `Unhandled action ${name}` });
        }
      } catch (error) {
        visit.pullEvents();
        return respond(409, {
          error: error instanceof Error ? error.message : "Conflict",
        });
      }

      const events = visit.pullEvents();
      for (const domainEvent of events) {
        publish(
          visit,
          domainEvent.type,
          (domainEvent.payload as { stationId?: StationId }).stationId ?? null,
        );
      }
      return respond(200, { visit: { state: visitToWire(visit) } });
    }

    // Configuration writes echo the merged configuration, which is what the
    // server returns and what the store replaces its cache from.
    if (method === "PATCH" || (method === "POST" && url.includes("/api/v1/")) || method === "DELETE") {
      if (url.includes("/roles")) {
        // Roles have their own rule, and it guards one specific catastrophe:
        // a hospital editing its way to having no role that can manage users.
        const next = applyRoleWrite(roles, url, method, body);
        const problems = validateRoles(next);
        if (problems.length > 0) {
          return respond(422, {
            error: "That change is not valid.",
            problems: problems.map((message) => ({
              path: "roles",
              message,
              severity: "error",
            })),
          });
        }
        roles.splice(0, roles.length, ...next);
        return respond(200, { roles });
      }

      /**
       * Validated by the domain, exactly as the server validates it.
       *
       * Echoing the patch unvalidated would let a suite assert that an invalid
       * configuration saved — which is the opposite of what those tests are
       * for. The rule itself is not restated here: this calls the same
       * function the API calls.
       */
      const next = applyWrite(current, url, method, body);
      const problems = validateHospitalConfiguration(next);
      if (hasBlockingProblems(problems)) {
        return respond(422, {
          error: "That change is not valid.",
          problems: problems.filter((p) => p.severity === "error"),
        });
      }

      current = next;
      return respond(200, {
        configuration: current,
        warnings: problems.filter((p) => p.severity === "warning"),
      });
    }

    return respond(404, { error: `Unhandled ${method} ${url}` });
  }) as unknown as typeof globalThis.fetch;

  /**
   * The application's own stores, loaded through the stubbed transport.
   *
   * Components call `useConfig()` and `useClinic()` with no argument, which
   * resolves to these. Building separate instances would mean every test had to
   * inject them into every component — and would leave the ones that cannot be
   * injected reading an empty hospital.
   */
  const { config, clinic, auth } = stores;
  await config.load();
  await config.loadRoles();
  await auth.load();
  await clinic.load(BRANCH_ID);

  return {
    stream,
    config,
    clinic,
    auth,
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/** Applies a role change the way the service does, so validation sees the set. */
function applyRoleWrite(
  roles: readonly RoleConfig[],
  url: string,
  method: string,
  body: unknown,
): RoleConfig[] {
  const patch = (body ?? {}) as Partial<RoleConfig>;
  const id = decodeURIComponent(url.split("/").pop() ?? "");

  if (method === "POST") {
    return [
      ...roles,
      {
        id: `role-${(sequence += 1)}`,
        name: patch.name ?? "",
        description: patch.description ?? "",
        permissions: patch.permissions ?? [],
        isSystem: false,
      },
    ];
  }
  if (method === "DELETE") return roles.filter((role) => role.id !== id);
  return roles.map((role) => (role.id === id ? { ...role, ...patch } : role));
}

/**
 * The summary the server renders at write time.
 *
 * Kept in step with `visit-events.ts` on the API side; a suite reading the
 * audit trail is reading what the server said, not something re-derived here.
 */
function summaryFor(
  type: string,
  visit: Visit,
  configuration: HospitalConfiguration,
  stationId: StationId | null,
): string {
  const name = (id: StationId | null): string =>
    configuration.stations.find((s) => s.id === id)?.name ?? "Station";
  const here = stationId ?? visit.currentEntry?.stationId ?? null;

  switch (type) {
    case "visit.called":
      return `Called at ${name(here)}`;
    case "visit.service_started":
      return `Service started at ${name(here)}`;
    case "visit.skipped":
      return `Skipped at ${name(here)}`;
    case "visit.routed": {
      const entries = visit.queueEntries;
      const from = entries[entries.length - 2]?.stationId ?? null;
      return `Routed ${name(from)} → ${name(here)}`;
    }
    case "visit.completed":
      return `${visit.journeyCode} completed`;
    case "visit.cancelled":
      return `${visit.journeyCode} cancelled`;
    default:
      return `${visit.journeyCode}: ${type}`;
  }
}

function signedInUser(permissions: readonly Permission[]) {
  return {
    id: USER_ID,
    displayName: "Dr Adams",
    username: "adams",
    roleId: "role-admin",
    branchId: BRANCH_ID,
    branchIds: [BRANCH_ID],
    permissions,
  };
}

/**
 * Applies a write to the fixture's configuration.
 *
 * Deliberately shallow: it merges the patch into the addressed entity and
 * nothing else. The fixture is not a second implementation of the server — a
 * suite asserting a rule the server enforces belongs in the API tests, where
 * that rule actually lives.
 */
function applyWrite(
  configuration: HospitalConfiguration,
  url: string,
  method: string,
  body: unknown,
): HospitalConfiguration {
  const patch = (body ?? {}) as Record<string, unknown>;
  const id = decodeURIComponent(url.split("/").pop() ?? "");

  const mergeInto = <T extends { id: string }>(list: readonly T[]): T[] =>
    list.map((item) => (item.id === id ? { ...item, ...patch } : item));

  if (url.includes("/stations")) {
    if (method === "POST") {
      return {
        ...configuration,
        stations: [
          ...configuration.stations,
          { ...configuration.stations[0], ...patch, id: `station-${(sequence += 1)}` } as StationConfig,
        ],
      };
    }
    if (method === "DELETE") {
      return { ...configuration, stations: configuration.stations.filter((s) => s.id !== id) };
    }
    return { ...configuration, stations: mergeInto(configuration.stations) };
  }

  if (url.includes("/display-boards")) {
    if (method === "POST") {
      return {
        ...configuration,
        displayBoards: [
          ...configuration.displayBoards,
          { ...configuration.displayBoards[0], ...patch, id: `board-${(sequence += 1)}` } as DisplayBoardConfig,
        ],
      };
    }
    if (method === "DELETE") {
      return {
        ...configuration,
        displayBoards: configuration.displayBoards.filter((b) => b.id !== id),
      };
    }
    return { ...configuration, displayBoards: mergeInto(configuration.displayBoards) };
  }

  if (url.includes("/workflows")) {
    return { ...configuration, workflows: mergeInto(configuration.workflows as never) as never };
  }
  if (url.includes("/ticket-templates")) {
    return { ...configuration, ticketTemplates: mergeInto(configuration.ticketTemplates) };
  }
  if (url.includes("/profile")) {
    return { ...configuration, profile: { ...configuration.profile, ...patch } };
  }
  if (url.includes("/settings")) {
    return { ...configuration, defaults: { ...configuration.defaults, ...patch } };
  }

  return configuration;
}
