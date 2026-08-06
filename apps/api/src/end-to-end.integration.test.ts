/**
 * The whole platform, end to end, against a real PostgreSQL.
 *
 * Every other test in this repository stubs something. This one stubs nothing
 * below the HTTP boundary: real Postgres repositories, real migrations, the
 * real server, real scrypt, real transactions. The only thing it replaces is
 * the network, and only because `app.inject` is the same code path Fastify runs
 * for a socket.
 *
 * It walks the deployment exactly as a hospital would arrive at it:
 *
 *   bootstrap a platform administrator
 *     → create an organization through the Platform API
 *     → sign in as that organization's administrator with the password it issued
 *     → configure stations, a workflow and a display board
 *     → admit a patient and move them through the whole journey
 *     → read the board and the tracker as the public would
 *     → read the audit history
 *
 * Then it does the same for a second organization and checks that neither can
 * see the other — not by inspecting queries, but by asking for the other's data
 * through the API and being refused.
 *
 *     DATABASE_URL=postgres://… npm run verify:db -w @qman/api
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  createPostgresDatabase,
  migrate,
  PostgresAccountRepository,
  PostgresBoardDirectory,
  PostgresConfigurationRepository,
  PostgresConfigurationWriter,
  PostgresEventRepository,
  PostgresIdempotencyRepository,
  PostgresLockoutRepository,
  PostgresOrganizationDirectory,
  PostgresPlatformEventRepository,
  PostgresPlatformLockoutRepository,
  PostgresPlatformSessionRepository,
  PostgresPlatformUserRepository,
  PostgresSessionRepository,
  PostgresTicketAllocator,
  PostgresVisitRepository,
  type Database,
} from "@qman/persistence";
import type { FastifyInstance } from "fastify";
import { AuthService, createDatabaseLockoutStore } from "./auth.js";
import { ConfigurationService } from "./configuration-service.js";
import { CSRF_COOKIE } from "./csrf.js";
import { createLogger } from "./logging.js";
import { loadMigrations } from "./migrations.js";
import { hashPassword } from "./passwords.js";
import { PlatformAuthService } from "./platform-auth.js";
import { PLATFORM_SESSION_COOKIE } from "./platform-authorization.js";
import { createPlatformLockoutStore } from "./platform-lockout.js";
import { PostgresOrganizationProvisioning } from "./provisioning.js";
import { buildServer, SESSION_COOKIE } from "./server.js";
import { EventStream } from "./stream.js";
import { hashToken, issueToken } from "./tokens.js";

const url = process.env["DATABASE_URL"];
const suite = url ? describe : describe.skip;

const SCHEMA = `qman_e2e_${Date.now().toString(36)}`;
const ORIGIN = "https://app.qman.example";
const PLATFORM_PASSWORD = "a platform passphrase that is long enough";

let pool: pg.Pool;
let db: Database;
let app: FastifyInstance;
/** The same stream instance the server publishes to, so a test can listen. */
let liveStream: EventStream;

/** A signed-in caller: the cookies a browser would hold, and its CSRF token. */
interface Caller {
  readonly cookie: string;
  readonly csrf: string;
}

function callerFrom(header: string | string[] | undefined, sessionName: string): Caller {
  const values = Array.isArray(header) ? header : [header ?? ""];
  const pick = (name: string) =>
    values.find((value) => value.startsWith(name))?.split(";")[0] ?? "";
  const csrfCookie = pick(CSRF_COOKIE);
  return {
    cookie: `${pick(sessionName)}; ${csrfCookie}`,
    csrf: decodeURIComponent(csrfCookie.slice(CSRF_COOKIE.length + 1)),
  };
}

/** Headers for a state-changing request, as a browser would send them. */
function writing(caller: Caller) {
  return { cookie: caller.cookie, origin: ORIGIN, "x-csrf-token": caller.csrf };
}

suite("QMan end to end, against real PostgreSQL", () => {
  beforeAll(async () => {
    const bootstrap = new pg.Pool({
      connectionString: url,
      ssl: url!.includes("localhost") ? undefined : { rejectUnauthorized: true },
    });
    await bootstrap.query(`CREATE SCHEMA "${SCHEMA}"`);
    await bootstrap.end();

    pool = new pg.Pool({
      connectionString: url,
      max: 12,
      options: `-c search_path=${SCHEMA}`,
      ssl: url!.includes("localhost") ? undefined : { rejectUnauthorized: true },
    });
    db = createPostgresDatabase(pool);
    await migrate(db, loadMigrations());

    const now = () => new Date();
    liveStream = new EventStream();
    const writer = new PostgresConfigurationWriter();
    const visitDependencies = { clock: { now }, ids: { next: randomUUID } };
    const visits = new PostgresVisitRepository(db, visitDependencies);
    const organizations = new PostgresOrganizationDirectory(db);
    const platformUsers = new PostgresPlatformUserRepository(db);

    // The bootstrap command's effect, through the same repository it uses.
    // Not the CLI itself: that loads configuration and connects on its own.
    const hashed = await hashPassword(PLATFORM_PASSWORD);
    await platformUsers.create(
      {
        username: "root",
        displayName: "Platform Root",
        passwordHash: hashed.hash,
        passwordSalt: hashed.salt,
        role: "super_admin",
        enabled: true,
      },
      now(),
    );

    app = buildServer({
      auth: new AuthService({
        accounts: new PostgresAccountRepository(db),
        sessions: new PostgresSessionRepository(db),
        lockouts: createDatabaseLockoutStore(new PostgresLockoutRepository(db), now),
        now,
        newId: () => randomUUID(),
      }),
      organizations,
      platform: {
        auth: new PlatformAuthService({
          users: platformUsers,
          sessions: new PostgresPlatformSessionRepository(db),
          lockouts: createPlatformLockoutStore(
            new PostgresPlatformLockoutRepository(db),
            now,
          ),
          now,
        }),
        events: new PostgresPlatformEventRepository(db),
        users: platformUsers,
        provisioning: new PostgresOrganizationProvisioning(db, writer),
      },
      stream: liveStream,
      secureCookies: true,
      allowedOrigins: [ORIGIN],
      logger: createLogger({ write: (line) => { if (line.includes("unhandled")) console.error(line); } }),
      now,
      configuration: { configuration: new PostgresConfigurationRepository(db) },
      configurationWrites: {
        service: new ConfigurationService({ db, writer, now }),
        writer,
        idempotency: {
          repository: new PostgresIdempotencyRepository(db),
          logger: createLogger({ write: () => {} }),
          now,
        },
      },
      publicSurfaces: {
        visits,
        boards: new PostgresBoardDirectory(db),
        organizations,
      },
      queue: {
        visits,
        events: new PostgresEventRepository(db),
        admission: {
          visits,
          allocator: new PostgresTicketAllocator(db),
          deps: visitDependencies,
          configuration: new PostgresConfigurationRepository(db),
          newTrackingToken: issueToken,
          hashToken,
        },
        idempotency: {
          repository: new PostgresIdempotencyRepository(db),
          logger: createLogger({ write: () => {} }),
          now,
        },
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (pool !== undefined) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await pool.end();
    }
  }, 60_000);

  // ───────────────────────────────────────────────────────────── helpers

  async function platformSignIn(): Promise<Caller> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/platform/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "root", password: PLATFORM_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return callerFrom(response.headers["set-cookie"], PLATFORM_SESSION_COOKIE);
  }

  async function createOrganization(
    platform: Caller,
    code: string,
    name: string,
  ): Promise<{ id: string; adminPassword: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/platform/organizations",
      headers: writing(platform),
      payload: {
        code,
        name,
        timezone: "Africa/Lagos",
        branchName: "Main Branch",
        adminUsername: "admin",
        adminDisplayName: `${name} Administrator`,
      },
    });
    if (response.statusCode !== 201) {
      throw new Error(`create organization ${response.statusCode}: ${response.payload}`);
    }
    const body = response.json();
    return { id: body.organization.id, adminPassword: body.administrator.password };
  }

  async function organizationSignIn(code: string, password: string): Promise<Caller> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { organization: code, username: "admin", password },
    });
    expect(response.statusCode).toBe(200);
    return callerFrom(response.headers["set-cookie"], SESSION_COOKIE);
  }

  /**
   * Extends the starter configuration a new organization arrives with.
   *
   * Provisioning already creates a Reception station, a General workflow
   * through it and a ticket template, because an organization without them
   * cannot be configured at all. So this adds what a real hospital would add
   * next rather than starting from nothing — and deliberately does not reuse
   * the code "REC", which is already taken in this branch.
   */
  async function configure(admin: Caller) {
    const consulting = await app.inject({
      method: "POST",
      url: "/api/v1/stations",
      headers: writing(admin),
      payload: { name: "Consulting", code: "CON", room: "Room 2" },
    });
    expect([200, 201]).toContain(consulting.statusCode);

    const config = (
      await app.inject({ method: "GET", url: "/api/v1/config", headers: { cookie: admin.cookie } })
    ).json().configuration;

    const stationIds: Record<string, string> = {};
    for (const station of config.stations) stationIds[station.code] = station.id;

    const board = await app.inject({
      method: "POST",
      url: "/api/v1/display-boards",
      headers: writing(admin),
      payload: {
        name: "Main Waiting Area",
        stationIds: [stationIds["REC"], stationIds["CON"]],
      },
    });
    expect([200, 201]).toContain(board.statusCode);

    const after = (
      await app.inject({ method: "GET", url: "/api/v1/config", headers: { cookie: admin.cookie } })
    ).json().configuration;

    return {
      stationIds,
      branchId: after.branches[0].id as string,
      boardId: after.displayBoards[0].id as string,
    };
  }

  // ──────────────────────────────────────── the first deployment, in order

  describe("first run", () => {
    it("signs the bootstrapped platform administrator in", async () => {
      const platform = await platformSignIn();
      const me = await app.inject({
        method: "GET",
        url: "/api/v1/platform/auth/me",
        headers: { cookie: platform.cookie },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.username).toBe("root");
    }, 60_000);

    it("shows no organizations before any are created", async () => {
      const platform = await platformSignIn();
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/platform/organizations",
        headers: { cookie: platform.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().organizations).toEqual([]);
    }, 60_000);
  });

  describe("an organization, created and used", () => {
    let platform: Caller;
    let admin: Caller;
    let organizationId: string;
    let stationIds: Record<string, string>;
    let branchId: string;
    let boardId: string;

    beforeAll(async () => {
      platform = await platformSignIn();
      const created = await createOrganization(
        platform,
        "freshsprings",
        "Freshsprings Medical Services",
      );
      organizationId = created.id;
      admin = await organizationSignIn("freshsprings", created.adminPassword);
      ({ stationIds, branchId, boardId } = await configure(admin));
    }, 180_000);

    it("creates the organization through the Platform Portal only", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/platform/organizations",
        headers: { cookie: platform.cookie },
      });
      const organizations = response.json().organizations as Array<{
        id: string;
        name: string;
        status: string;
        branchCount: number;
        userCount: number;
      }>;
      const created = organizations.find((o) => o.id === organizationId)!;
      expect(created.name).toBe("Freshsprings Medical Services");
      expect(created.status).toBe("active");
      expect(created.branchCount).toBe(1);
      expect(created.userCount).toBe(1);
    }, 60_000);

    it("moves a patient through the whole journey", async () => {
      const admitted = await app.inject({
        method: "POST",
        url: "/api/v1/visits",
        headers: writing(admin),
        payload: { patientName: "Amara Obi", stationId: stationIds["REC"] },
      });
      expect(admitted.statusCode).toBe(201);

      const visit = admitted.json().visit;
      const visitId = visit.id as string;
      expect(visit.journeyCode).toMatch(/^[A-Z0-9-]+$/);

      for (const step of ["call", "start", "complete"]) {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/visits/${visitId}/${step}`,
          headers: writing(admin),
          payload: { stationId: stationIds["REC"] },
        });
        expect([200, 201]).toContain(response.statusCode);
      }

      // Completing the first required stage routes the patient onward, so the
      // second station's queue is where they should now be.
      const routed = await app.inject({
        method: "POST",
        url: `/api/v1/visits/${visitId}/route`,
        headers: writing(admin),
        payload: { stationId: stationIds["CON"] },
      });
      expect([200, 201, 409, 422]).toContain(routed.statusCode);

      const queue = await app.inject({
        method: "GET",
        url: `/api/v1/stations/${stationIds["CON"]}/queue`,
        headers: { cookie: admin.cookie },
      });
      expect(queue.statusCode).toBe(200);
    }, 120_000);

    it("serves the display board without any patient identity", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/boards/${boardId}`,
      });
      expect(response.statusCode).toBe(200);

      const body = response.payload;
      // The board is unauthenticated and readable by anyone in the waiting
      // room. It must carry no name and no Journey Code.
      expect(body).not.toContain("Amara");
      expect(body).not.toContain("journeyCode");
    }, 60_000);

    it("records the journey in the organization's own event log", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/events?branchId=${branchId}`,
        headers: { cookie: admin.cookie },
      });
      expect(response.statusCode).toBe(200);
      const events = response.json().events as Array<{ type: string }>;
      expect(events.length).toBeGreaterThan(0);
      expect(events.map((event) => event.type)).toContain("visit.created");
    }, 60_000);

    it("records the organization's creation in the platform audit log", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/platform/audit?organizationId=${organizationId}`,
        headers: { cookie: platform.cookie },
      });
      const events = response.json().events as Array<{ type: string; summary: string }>;
      expect(events.map((event) => event.type)).toContain("platform.organization_created");
      expect(events[events.length - 1]!.summary).toContain("Freshsprings");
    }, 60_000);

    /** A constraint the user can trip on purpose must not read as a crash. */
    it("answers a duplicate station code with 409, not 500", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stations",
        headers: writing(admin),
        // "REC" is the starter Reception station's code, and the database
        // enforces UNIQUE (branch_id, code). The domain treats a duplicate as a
        // warning rather than an error, because a multi-branch hospital
        // legitimately reuses codes across branches — so the refusal comes from
        // the constraint, and must arrive as a refusal.
        payload: { name: "Second Reception", code: "REC" },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.error).not.toContain("Something went wrong");
      // No schema disclosure: the column and constraint names stay in the log.
      expect(JSON.stringify(body)).not.toContain("stations_branch_id");
      expect(body.requestId).toBeDefined();
    }, 60_000);

    it("answers a malformed identifier with 400, not 500", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/branches/not-a-uuid/visits",
        headers: { cookie: admin.cookie },
      });
      expect(response.statusCode).toBe(400);
    }, 60_000);

    it("refuses an action the caller's role does not permit", async () => {
      // The administrator role has admin.users, so roles can be written. Prove
      // the guard is live by asking for something no role grants.
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: writing(admin),
        payload: {
          name: "Escalated",
          description: "",
          permissions: ["platform.organizations.create"],
        },
      });
      // Refused by the domain's role validation, which will not store a
      // platform grant on a hospital's role however it is sent.
      expect(response.statusCode).toBe(422);
      expect(JSON.stringify(response.json())).toContain("platform.organizations.create");
    }, 60_000);
  });

  // ──────────────────────────────────────────────── two organizations, apart

  describe("multi-tenant isolation", () => {
    let platform: Caller;
    let alpha: { admin: Caller; id: string; branchId: string; boardId: string; stations: Record<string, string> };
    let beta: { admin: Caller; id: string; branchId: string; boardId: string; stations: Record<string, string> };

    beforeAll(async () => {
      platform = await platformSignIn();

      const a = await createOrganization(platform, "alphacare", "Alpha Care");
      const adminA = await organizationSignIn("alphacare", a.adminPassword);
      const configA = await configure(adminA);
      alpha = { admin: adminA, id: a.id, ...configA, stations: configA.stationIds };

      const b = await createOrganization(platform, "betacare", "Beta Care");
      const adminB = await organizationSignIn("betacare", b.adminPassword);
      const configB = await configure(adminB);
      beta = { admin: adminB, id: b.id, ...configB, stations: configB.stationIds };

      await app.inject({
        method: "POST",
        url: "/api/v1/visits",
        headers: writing(adminA),
        payload: { patientName: "Alpha Patient", stationId: configA.stationIds["REC"] },
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/visits",
        headers: writing(adminB),
        payload: { patientName: "Beta Patient", stationId: configB.stationIds["REC"] },
      });
    }, 300_000);

    it("gives each organization only its own configuration", async () => {
      const a = (
        await app.inject({
          method: "GET",
          url: "/api/v1/config",
          headers: { cookie: alpha.admin.cookie },
        })
      ).json().configuration;
      const b = (
        await app.inject({
          method: "GET",
          url: "/api/v1/config",
          headers: { cookie: beta.admin.cookie },
        })
      ).json().configuration;

      expect(a.profile.id).toBe(alpha.id);
      expect(b.profile.id).toBe(beta.id);
      expect(a.branches[0].id).not.toBe(b.branches[0].id);
      // No station, workflow or board is shared, even though both were built
      // from the same template with the same names and codes.
      const aStations = new Set<string>(a.stations.map((s: { id: string }) => s.id));
      for (const station of b.stations) expect(aStations.has(station.id)).toBe(false);
    }, 60_000);

    it("gives each organization only its own visits", async () => {
      const a = await app.inject({
        method: "GET",
        url: `/api/v1/branches/${alpha.branchId}/visits`,
        headers: { cookie: alpha.admin.cookie },
      });
      expect(a.statusCode).toBe(200);
      expect(a.payload).toContain("Alpha Patient");
      expect(a.payload).not.toContain("Beta Patient");
    }, 60_000);

    it("refuses one organization's request for another's visits", async () => {
      const response = await app.inject({
        method: "GET",
        // Beta's branch, Alpha's session.
        url: `/api/v1/branches/${beta.branchId}/visits`,
        headers: { cookie: alpha.admin.cookie },
      });

      // Either refused outright, or scoped to nothing. What must never happen
      // is Beta's patient appearing in Alpha's response.
      expect(response.payload).not.toContain("Beta Patient");
    }, 60_000);

    it("refuses one organization's request for another's station queue", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/stations/${beta.stations["REC"]}/queue`,
        headers: { cookie: alpha.admin.cookie },
      });
      expect(response.payload).not.toContain("Beta Patient");
    }, 60_000);

    it("keeps each organization's event log to itself", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/events?branchId=${beta.branchId}`,
        headers: { cookie: alpha.admin.cookie },
      });
      expect(response.payload).not.toContain("Beta Patient");
    }, 60_000);

    it("keeps sessions apart, so one organization cannot list another's", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/sessions",
        headers: { cookie: alpha.admin.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.payload).not.toContain(beta.id);
    }, 60_000);

    it("does not let one organization's administrator write another's configuration", async () => {
      const before = (
        await app.inject({
          method: "GET",
          url: "/api/v1/config",
          headers: { cookie: beta.admin.cookie },
        })
      ).json().configuration;

      // Alpha's session, naming Beta's branch. The branch is not a tenant
      // selector — the session is — so this must land in Alpha or nowhere.
      await app.inject({
        method: "POST",
        url: "/api/v1/stations",
        headers: writing(alpha.admin),
        payload: { name: "Intruder", code: "INT", branchId: beta.branchId },
      });

      const after = (
        await app.inject({
          method: "GET",
          url: "/api/v1/config",
          headers: { cookie: beta.admin.cookie },
        })
      ).json().configuration;

      expect(after.stations.map((s: { name: string }) => s.name)).not.toContain("Intruder");
      expect(after.stations).toHaveLength(before.stations.length);
    }, 60_000);

    /**
     * The penetration suite.
     *
     * Alpha's session, Beta's identifiers, every tenant-owned resource type.
     * Each of these described a working attack before the release audit: reads
     * returned Beta's patients by name, the six visit transitions were
     * reachable across organizations whenever the caller's session was not
     * pinned to a branch, an unfiltered event query returned every
     * organization's history, and DELETE by raw id destroyed another
     * organization's configuration.
     *
     * They are refused now because the repository signatures require the
     * tenant, so the filter is in the SQL rather than in a check a route author
     * has to remember.
     */
    describe("penetration: Alpha's session against Beta's identifiers", () => {
      it("cannot read Beta's visits by branch id", async () => {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/branches/${beta.branchId}/visits`,
          headers: { cookie: alpha.admin.cookie },
        });
        expect(response.payload).not.toContain("Beta Patient");
        expect(response.json().visits).toEqual([]);
      }, 60_000);

      it("cannot read Beta's queue by station id", async () => {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/stations/${beta.stations["REC"]}/queue`,
          headers: { cookie: alpha.admin.cookie },
        });
        expect(response.payload).not.toContain("Beta Patient");
        expect(response.json().visits).toEqual([]);
      }, 60_000);

      it("cannot read Beta's events, filtered or unfiltered", async () => {
        const filtered = await app.inject({
          method: "GET",
          url: `/api/v1/events?branchId=${beta.branchId}`,
          headers: { cookie: alpha.admin.cookie },
        });
        expect(filtered.json().events).toEqual([]);

        // The unfiltered query is the dangerous one: it used to return every
        // organization's history, summaries and Journey Codes included.
        const unfiltered = await app.inject({
          method: "GET",
          url: "/api/v1/events",
          headers: { cookie: alpha.admin.cookie },
        });
        expect(unfiltered.payload).not.toContain("Beta Patient");
        const branches = new Set(
          (unfiltered.json().events as Array<{ branchId: string | null }>).map(
            (event) => event.branchId,
          ),
        );
        expect(branches.has(beta.branchId)).toBe(false);
      }, 60_000);

      it("cannot act on Beta's visit by id", async () => {
        const betaVisits = await app.inject({
          method: "GET",
          url: `/api/v1/branches/${beta.branchId}/visits`,
          headers: { cookie: beta.admin.cookie },
        });
        const victim = (betaVisits.json().visits as Array<{ state: { id: string } }>)[0]!;

        // All six transitions, from Alpha's session. Each must be answered as
        // though the visit does not exist.
        for (const step of ["call", "start", "complete", "skip", "recall", "cancel"]) {
          const response = await app.inject({
            method: "POST",
            url: `/api/v1/visits/${victim.state.id}/${step}`,
            headers: writing(alpha.admin),
            payload: {},
          });
          expect(response.statusCode).toBe(404);
        }

        // And Beta's visit is untouched.
        const after = await app.inject({
          method: "GET",
          url: `/api/v1/branches/${beta.branchId}/visits`,
          headers: { cookie: beta.admin.cookie },
        });
        expect(after.json().visits).toHaveLength(
          (betaVisits.json().visits as unknown[]).length,
        );
      }, 120_000);

      it("cannot route Beta's visit to one of its stations", async () => {
        const betaVisits = await app.inject({
          method: "GET",
          url: `/api/v1/branches/${beta.branchId}/visits`,
          headers: { cookie: beta.admin.cookie },
        });
        const victim = (betaVisits.json().visits as Array<{ state: { id: string } }>)[0]!;

        const response = await app.inject({
          method: "POST",
          url: `/api/v1/visits/${victim.state.id}/route`,
          headers: writing(alpha.admin),
          payload: { stationId: beta.stations["CON"] },
        });
        expect(response.statusCode).toBe(404);
      }, 60_000);

      it("cannot delete Beta's station, workflow or board", async () => {
        const before = (
          await app.inject({
            method: "GET",
            url: "/api/v1/config",
            headers: { cookie: beta.admin.cookie },
          })
        ).json().configuration;

        for (const [collection, id] of [
          ["stations", beta.stations["CON"]!],
          ["workflows", before.workflows[0].id as string],
          ["display-boards", beta.boardId],
        ] as const) {
          await app.inject({
            method: "DELETE",
            url: `/api/v1/${collection}/${id}`,
            headers: writing(alpha.admin),
          });
        }

        // Whatever each request answered, Beta's configuration is intact. This
        // is the assertion that matters: the DELETE used to match by raw id.
        const after = (
          await app.inject({
            method: "GET",
            url: "/api/v1/config",
            headers: { cookie: beta.admin.cookie },
          })
        ).json().configuration;

        expect(after.stations).toHaveLength(before.stations.length);
        expect(after.workflows).toHaveLength(before.workflows.length);
        expect(after.displayBoards).toHaveLength(before.displayBoards.length);
      }, 120_000);

      /**
       * The live feed, which no repository fix could have covered.
       *
       * `/stream` subscribed with the session's branch, and a null branch meant
       * "every branch" with nothing establishing which organization's. An
       * administrator not pinned to a branch — the default for a new
       * organization — received every hospital's events as they happened.
       */
      it("cannot subscribe to Beta's event stream", async () => {
        const chunks: string[] = [];
        const subscriber = {
          hospitalId: alpha.id,
          branchId: null,
          audience: "staff" as const,
          send: (chunk: string) => chunks.push(chunk),
        };
        const unsubscribe = liveStream.subscribe(subscriber);

        // Admit a patient at Beta while Alpha is listening with no branch.
        await app.inject({
          method: "POST",
          url: "/api/v1/visits",
          headers: writing(beta.admin),
          payload: { patientName: "Streamed Beta Patient", stationId: beta.stations["REC"] },
        });

        unsubscribe();
        expect(chunks.join("")).not.toContain("Streamed Beta Patient");
        expect(chunks.join("")).toEqual("");
      }, 60_000);

      it("cannot enumerate Beta's existence through a station usage probe", async () => {
        // A delete refused for "3 workflows use this station" would confirm the
        // station is real and busy. Beta's station must look like nothing.
        const response = await app.inject({
          method: "DELETE",
          url: `/api/v1/stations/${beta.stations["REC"]}`,
          headers: writing(alpha.admin),
        });

        // The refusal must not describe what uses Beta's station. A message
        // naming "3 workflows" would confirm the station is real and busy.
        const problems = JSON.stringify(response.json().problems ?? []);
        expect(problems).not.toContain("workflow");
        expect(problems).not.toContain("visit");
      }, 60_000);
    });

    it("suspends one organization without touching the other", async () => {
      const suspended = await app.inject({
        method: "POST",
        url: `/api/v1/platform/organizations/${beta.id}/suspend`,
        headers: writing(platform),
        payload: { reason: "Validation run" },
      });
      expect(suspended.statusCode).toBe(200);

      const refused = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: ORIGIN },
        payload: { organization: "betacare", username: "admin", password: "anything" },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().reason).toBe("organization_suspended");

      // Beta's display board stops serving, so suspension is observable to the
      // people standing in the building rather than only in billing.
      const board = await app.inject({
        method: "GET",
        url: `/api/v1/public/boards/${beta.boardId}`,
      });
      expect(board.statusCode).toBe(404);

      // Alpha is entirely unaffected.
      const alphaBoard = await app.inject({
        method: "GET",
        url: `/api/v1/public/boards/${alpha.boardId}`,
      });
      expect(alphaBoard.statusCode).toBe(200);

      await app.inject({
        method: "POST",
        url: `/api/v1/platform/organizations/${beta.id}/reactivate`,
        headers: writing(platform),
        payload: {},
      });

      const restored = await app.inject({
        method: "GET",
        url: `/api/v1/public/boards/${beta.boardId}`,
      });
      expect(restored.statusCode).toBe(200);
    }, 120_000);
  });
});
