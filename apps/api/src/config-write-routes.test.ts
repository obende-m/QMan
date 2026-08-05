/**
 * Configuration writes.
 *
 * Driven over HTTP against a real transaction fake, because the properties that
 * matter are not "does the field change" but "what happens when it must not":
 * a rejected change writes nothing including its audit entry, a caller without
 * the permission gets no further than the guard, and every accepted change
 * leaves an entry naming who did it and what it was before.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TICKET_TEMPLATE,
  UserId,
  type HospitalConfiguration,
  type RoleConfig,
  type Session,
  type StationConfig,
} from "@qman/domain";
import {
  FakeDatabase,
  type AccountRepository,
  type ConfigurationRepository,
  type ConfigurationWriter,
  type SessionRepository,
  type SqlExecutor,
  type StoredAccount,
} from "@qman/persistence";
import { AuthService, createMemoryLockoutStore } from "./auth.js";
import { ConfigurationService } from "./configuration-service.js";
import { hashPassword } from "./passwords.js";
import { buildServer } from "./server.js";
import { silentLogger } from "./logging.js";

const ORIGIN = "https://qman.hospital.example";
const HOSPITAL = "11111111-1111-1111-1111-111111111111";
const STATION = "44444444-4444-4444-4444-444444444444";
const WORKFLOW = "66666666-6666-6666-6666-666666666666";
const PASSWORD = "a reasonable passphrase";
const FAST = { N: 1024, r: 8, p: 1, keyLength: 64 };

function stationConfig(overrides: Partial<StationConfig> = {}): StationConfig {
  return {
    id: STATION,
    name: "Consultation",
    code: "CONS",
    room: "Room 12",
    staffing: 2,
    serviceEstimateMillis: 600_000,
    sla: { targetWaitMillis: 1_200_000, saturationPoint: 20 },
    queueNumber: { template: "A-{n:3}", reset: "daily", manualEpoch: null },
    isPublic: true,
    enabled: true,
    ...overrides,
  } as StationConfig;
}

function configuration(): HospitalConfiguration {
  return {
    profile: {
      id: HOSPITAL,
      name: "Ikeja General Hospital",
      code: "IKJ",
      timezone: "Africa/Lagos",
      supportPhone: null,
      brandColor: "#003ec7",
    },
    branches: [{ id: "branch-1", name: "Main", code: "MAIN", isDefault: true }],
    stations: [stationConfig()],
    // A configuration must be admissible to be worth testing changes against:
    // the domain requires a workflow and a ticket template before a patient
    // can be admitted at all.
    workflows: [
      {
        id: WORKFLOW,
        branchId: "branch-1",
        name: "Standard visit",
        isDefault: true,
        stages: [
          {
            id: "stage-1",
            stationId: STATION,
            sequence: 1,
            isRequired: true,
            allowSkip: false,
            allowRepeat: false,
            branchesTo: [],
          },
        ],
      },
    ],
    displayBoards: [],
    ticketTemplates: [DEFAULT_TICKET_TEMPLATE],
    defaults: { namePolicy: "ticket_only", ticketTemplateId: DEFAULT_TICKET_TEMPLATE.id },
  } as unknown as HospitalConfiguration;
}

/**
 * The service constructs its own repository against the transaction, so the
 * fake database must answer the configuration read. Queueing the rows the
 * loader expects keeps that honest rather than stubbing the repository away.
 */
function primeConfigurationRead(db: FakeDatabase, config: HospitalConfiguration): void {
  db.willReturn([
    {
      id: HOSPITAL,
      name: config.profile.name,
      code: config.profile.code,
      timezone: config.profile.timezone,
      support_phone: config.profile.supportPhone,
      brand_color: config.profile.brandColor,
    },
  ])
    .willReturn(config.branches.map((b) => ({ id: b.id, name: b.name, code: b.code, is_default: b.isDefault })))
    .willReturn(
      config.stations.map((s) => ({
        id: s.id,
        branch_id: "branch-1",
        name: s.name,
        code: s.code,
        room: s.room,
        staffing: s.staffing,
        service_estimate_ms: s.serviceEstimateMillis,
        sla_target_wait_ms: s.sla.targetWaitMillis,
        sla_saturation_point: s.sla.saturationPoint,
        queue_template: s.queueNumber.template,
        queue_reset: s.queueNumber.reset,
        queue_manual_epoch: null,
        is_public: s.isPublic,
        enabled: s.enabled,
      })),
    )
    .willReturn(
      config.workflows.map((w) => ({
        id: w.id,
        branch_id: "branch-1",
        name: w.name,
        is_default: w.isDefault,
      })),
    )
    .willReturn(
      config.workflows.flatMap((w) =>
        w.stages.map((stage) => ({
          id: stage.id,
          workflow_id: w.id,
          station_id: stage.stationId,
          sequence: stage.sequence,
          is_required: stage.isRequired,
          allow_skip: stage.allowSkip,
          allow_repeat: stage.allowRepeat,
          branches_to: [...stage.branchesTo],
        })),
      ),
    )
    .willReturn([])
    .willReturn(
      config.ticketTemplates.map((t) => ({
        id: t.id,
        name: t.name,
        paper: t.paper,
        elements: t.elements,
        instructions: t.instructions,
        footer: t.footer,
        name_policy: t.namePolicy,
        tracking_url: t.trackingUrl,
      })),
    )
    .willReturn([{ settings: config.defaults }]);
}

class RecordingWriter implements ConfigurationWriter {
  readonly stations: StationConfig[] = [];
  readonly others: string[] = [];

  async updateStation(_tx: SqlExecutor, s: StationConfig): Promise<void> {
    this.stations.push(s);
  }
  async updateWorkflow(): Promise<void> {
    this.others.push("workflow");
  }
  async updateBoard(): Promise<void> {
    this.others.push("board");
  }
  async updateTicketTemplate(): Promise<void> {
    this.others.push("template");
  }
  async updateProfile(): Promise<void> {
    this.others.push("profile");
  }
  async updateDefaults(): Promise<void> {
    this.others.push("defaults");
  }
}

class FakeConfiguration implements ConfigurationRepository {
  async load(): Promise<HospitalConfiguration | null> {
    return configuration();
  }
  async loadRoles(): Promise<RoleConfig[]> {
    return [];
  }
}

class FakeAccounts implements AccountRepository {
  readonly accounts: StoredAccount[] = [];
  async findByUsername(hospitalId: string, username: string): Promise<StoredAccount | null> {
    return (
      this.accounts.find(
        (a) =>
          a.hospitalId === hospitalId &&
          a.account.username.toLowerCase() === username.toLowerCase(),
      ) ?? null
    );
  }
  async findById(userId: string): Promise<StoredAccount | null> {
    return this.accounts.find((a) => a.account.id === userId) ?? null;
  }
  async updatePassword(): Promise<void> {}
}

class FakeSessions implements SessionRepository {
  readonly rows = new Map<string, { session: Session; tokenHash: string }>();
  async find(id: string): Promise<Session | null> {
    return this.rows.get(id)?.session ?? null;
  }
  async findByToken(tokenHash: string): Promise<Session | null> {
    for (const row of this.rows.values()) {
      if (row.tokenHash === tokenHash && row.session.endedAt === null) return row.session;
    }
    return null;
  }
  async create(session: Session, tokenHash: string): Promise<void> {
    this.rows.set(session.id, { session, tokenHash });
  }
  async activeForHospital(): Promise<Session[]> {
    return [];
  }
  async save(session: Session): Promise<void> {
    const existing = this.rows.get(session.id);
    if (existing) this.rows.set(session.id, { ...existing, session });
  }
  async endAllForUser(): Promise<number> {
    return 0;
  }
}

async function account(permissions: string[]): Promise<StoredAccount> {
  const stored = await hashPassword(PASSWORD, FAST);
  return {
    account: {
      id: UserId("aaaaaaaa-0000-0000-0000-000000000001"),
      displayName: "Adaeze Okonkwo",
      username: "adaeze",
      roleId: "r1",
      branchIds: [],
      providerId: "local",
      enabled: true,
    },
    hospitalId: HOSPITAL,
    roleKey: "admin",
    permissions,
    passwordHash: stored.hash,
    passwordSalt: stored.salt,
  } as StoredAccount;
}

describe("configuration writes", () => {
  let accounts: FakeAccounts;
  let sessions: FakeSessions;
  let db: FakeDatabase;
  let writer: RecordingWriter;

  function server() {
    return buildServer({
      auth: new AuthService({
        accounts,
        sessions,
        lockouts: createMemoryLockoutStore(),
        now: () => new Date("2026-03-09T09:00:00Z"),
        newId: () => "session-1",
      }),
      resolveHospital: () => HOSPITAL,
      secureCookies: true,
      allowedOrigins: [ORIGIN],
      logger: silentLogger(),
      configuration: { configuration: new FakeConfiguration() },
      configurationWrites: {
        service: new ConfigurationService({
          db,
          writer,
          now: () => new Date("2026-03-09T09:00:00Z"),
        }),
        writer,
      },
    });
  }

  async function signIn(app: ReturnType<typeof server>) {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "adaeze", password: PASSWORD },
    });
    const set = login.headers["set-cookie"] as string[];
    const cookie = set.map((c) => c.split(";")[0]).join("; ");
    const csrf = decodeURIComponent(
      set.find((c) => c.startsWith("qman_csrf"))!.split(";")[0]!.split("=")[1]!,
    );
    return { cookie, csrf };
  }

  beforeEach(() => {
    accounts = new FakeAccounts();
    sessions = new FakeSessions();
    db = new FakeDatabase();
    writer = new RecordingWriter();
  });

  it("applies a valid station change and persists only that entity", async () => {
    accounts.accounts.push(await account(["admin.stations"]));
    const app = server();
    const { cookie, csrf } = await signIn(app);
    primeConfigurationRead(db, configuration());

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/stations/${STATION}`,
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      payload: { sla: { targetWaitMillis: 900_000, saturationPoint: 15 } },
    });

    expect(response.statusCode).toBe(200);
    expect(writer.stations).toHaveLength(1);
    expect(writer.stations[0]!.sla.targetWaitMillis).toBe(900_000);
    expect(writer.others).toEqual([]);
  });

  /** A field absent from the patch must be left alone, not overwritten. */
  it("leaves fields the patch does not mention", async () => {
    accounts.accounts.push(await account(["admin.stations"]));
    const app = server();
    const { cookie, csrf } = await signIn(app);
    primeConfigurationRead(db, configuration());

    await app.inject({
      method: "PATCH",
      url: `/api/v1/stations/${STATION}`,
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      payload: { name: "Consultation A" },
    });

    const saved = writer.stations[0]!;
    expect(saved.name).toBe("Consultation A");
    expect(saved.room).toBe("Room 12");
    expect(saved.sla.targetWaitMillis).toBe(1_200_000);
  });

  /**
   * The property the whole design exists for: a change the domain rejects
   * writes nothing at all — not the entity, and not an audit entry claiming it
   * happened.
   */
  it("writes nothing when the domain rejects the result", async () => {
    accounts.accounts.push(await account(["admin.stations"]));
    const app = server();
    const { cookie, csrf } = await signIn(app);
    primeConfigurationRead(db, configuration());

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/stations/${STATION}`,
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      // An empty name is an error in validateHospitalConfiguration.
      payload: { name: "   " },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().problems.length).toBeGreaterThan(0);
    expect(writer.stations).toEqual([]);
    expect(db.matching("INSERT INTO events")).toHaveLength(0);
  });

  it("reports the domain's problems so a screen can point at the field", async () => {
    accounts.accounts.push(await account(["admin.stations"]));
    const app = server();
    const { cookie, csrf } = await signIn(app);
    primeConfigurationRead(db, configuration());

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/stations/${STATION}`,
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      payload: { name: "" },
    });

    const problems = response.json().problems as Array<{ path: string; severity: string }>;
    expect(problems.every((problem) => problem.severity === "error")).toBe(true);
    expect(problems[0]!.path).toContain("stations");
  });

  describe("audit", () => {
    it("records who changed what, from what, to what", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeConfigurationRead(db, configuration());

      await app.inject({
        method: "PATCH",
        url: `/api/v1/stations/${STATION}`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { sla: { targetWaitMillis: 900_000, saturationPoint: 15 } },
      });

      const [entry] = db.matching("INSERT INTO events");
      expect(entry).toBeDefined();

      const params = entry!.params;
      const payload = JSON.parse(params.find((p) => typeof p === "string" && p.includes("before")) as string);
      expect(payload.before.targetWaitMillis).toBe(1_200_000);
      expect(payload.after.targetWaitMillis).toBe(900_000);
      expect(payload.path).toBe(`stations.${STATION}.sla`);
      expect(payload.requestId).toBeDefined();
      expect(params).toContain("aaaaaaaa-0000-0000-0000-000000000001");
      expect(params).toContain(HOSPITAL);
    });

    /**
     * "Who changed this SLA" is the question asked months later. An entry
     * saying only "a station was updated" cannot answer it.
     */
    it("names the specific change rather than the entity", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeConfigurationRead(db, configuration());

      await app.inject({
        method: "PATCH",
        url: `/api/v1/stations/${STATION}`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { queueNumber: { template: "OPD-{n:4}", reset: "daily", manualEpoch: null } },
      });

      const [entry] = db.matching("INSERT INTO events");
      expect(entry!.params).toContain("config.queue_numbering_updated");
      expect(entry!.params.some((p) => typeof p === "string" && p.includes("OPD-{n:4}"))).toBe(
        true,
      );
    });

    /** Administrative records group by sitting, not by patient. */
    it("correlates the entry by session", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeConfigurationRead(db, configuration());

      await app.inject({
        method: "PATCH",
        url: `/api/v1/stations/${STATION}`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { name: "Consultation B" },
      });

      const [entry] = db.matching("INSERT INTO events");
      expect(entry!.params).toContain("session-1");
      expect(entry!.params).toContain("administrative");
    });

    /** The whole change lands in one transaction, audit included. */
    it("writes the entity and its audit entry in the same unit of work", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeConfigurationRead(db, configuration());

      await app.inject({
        method: "PATCH",
        url: `/api/v1/stations/${STATION}`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { name: "Consultation C" },
      });

      expect(db.committed).toHaveLength(1);
      expect(db.matching("INSERT INTO events")).toHaveLength(1);
    });
  });

  describe("permissions", () => {
    it("refuses a station change without admin.stations", async () => {
      accounts.accounts.push(await account(["admin.workflows"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/stations/${STATION}`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { name: "Nope" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().permission).toBe("admin.stations");
      expect(writer.stations).toEqual([]);
    });

    it("requires a separate permission for each kind of configuration", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);

      for (const [url, permission] of [
        ["/api/v1/workflows/w1", "admin.workflows"],
        ["/api/v1/display-boards/b1", "admin.display_boards"],
        ["/api/v1/profile", "admin.settings"],
        ["/api/v1/settings", "admin.settings"],
      ] as const) {
        const response = await app.inject({
          method: "PATCH",
          url,
          headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
          payload: {},
        });
        expect(response.json().permission).toBe(permission);
      }
    });

    it("refuses an unauthenticated write before reading anything", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const response = await server().inject({
        method: "PATCH",
        url: `/api/v1/stations/${STATION}`,
        headers: { origin: ORIGIN },
        payload: { name: "Nope" },
      });

      expect(response.statusCode).toBe(401);
      expect(db.statements).toEqual([]);
    });
  });
});
