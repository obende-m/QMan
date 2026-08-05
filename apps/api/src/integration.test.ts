/**
 * The persistence layer against a real PostgreSQL.
 *
 * Everything else in this repository is verified against a recording fake,
 * which proves what a repository *does* and cannot prove the server would
 * accept it. That gap is not theoretical: an earlier audit found
 * `UNIQUE (hospital_id, lower(username))` written as a table constraint, which
 * is a syntax error on every PostgreSQL that exists, and it had survived
 * because nothing had ever run.
 *
 * So this file exists to be run against a real instance — Neon, or any other,
 * since the schema uses no extensions. It skips silently without DATABASE_URL,
 * so an ordinary `npm test` is unaffected.
 *
 *     DATABASE_URL=postgres://… npm run verify:db -w @qman/api
 *
 * Everything runs inside a schema created for the run and dropped afterwards,
 * so it can be pointed at a database that already has data without destroying
 * it. The one thing it must not be pointed at is a production database: it
 * creates and drops a schema, and a mistake there is unrecoverable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  createPostgresDatabase,
  migrate,
  MigrationIntegrityError,
  PostgresAccountRepository,
  PostgresBoardDirectory,
  PostgresConfigurationRepository,
  PostgresConfigurationWriter,
  PostgresIdempotencyRepository,
  PostgresLockoutRepository,
  PostgresSessionRepository,
  PostgresTicketAllocator,
  type Database,
} from "@qman/persistence";
import { UserId, type Session } from "@qman/domain";
import { hashPassword } from "./passwords.js";
import { hashToken, issueToken } from "./tokens.js";
import { loadMigrations } from "./migrations.js";

const url = process.env["DATABASE_URL"];
const suite = url ? describe : describe.skip;

/** One schema per run, so concurrent runs and existing data are both safe. */
const SCHEMA = `qman_verify_${Date.now().toString(36)}`;

const HOSPITAL = "11111111-1111-1111-1111-111111111111";
const BRANCH = "22222222-2222-2222-2222-222222222222";
const ROLE = "33333333-3333-3333-3333-333333333333";
const STATION = "44444444-4444-4444-4444-444444444444";
const USER = "55555555-5555-5555-5555-555555555555";

let pool: pg.Pool;
let db: Database;

suite("persistence against real PostgreSQL", () => {
  beforeAll(async () => {
    // The schema is created on a throwaway connection, because the pool below
    // pins search_path and cannot be used before the schema exists.
    const bootstrap = new pg.Pool({
      connectionString: url,
      ssl: url!.includes("localhost") ? undefined : { rejectUnauthorized: true },
    });
    await bootstrap.query(`CREATE SCHEMA "${SCHEMA}"`);
    await bootstrap.end();

    pool = new pg.Pool({
      connectionString: url,
      max: 12,
      // Applied to every connection the pool opens, so migrations and
      // repositories agree on where the tables are.
      options: `-c search_path=${SCHEMA}`,
      ssl: url!.includes("localhost") ? undefined : { rejectUnauthorized: true },
    });
    db = createPostgresDatabase(pool);
  }, 60_000);

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await pool.end();
    }
  }, 60_000);

  describe("migrations", () => {
    it("applies every migration to an empty schema", async () => {
      const outcome = await migrate(db, loadMigrations());
      expect(outcome.applied).toEqual([
        "001_initial",
        "002_session_tokens",
        "003_login_throttle",
        "004_idempotency",
        "005_tracking_tokens",
      ]);
    }, 120_000);

    it("creates every table the repositories read", async () => {
      const rows = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
        [SCHEMA],
      );
      const tables = new Set(rows.map((row) => row.table_name));
      for (const expected of [
        "hospitals",
        "branches",
        "roles",
        "users",
        "user_branches",
        "sessions",
        "stations",
        "visits",
        "queue_entries",
        "queue_number_sequences",
        "events",
        "login_throttle",
        "idempotency_keys",
        "schema_migrations",
      ]) {
        expect(tables.has(expected)).toBe(true);
      }
    });

    /** The unique index that replaced an invalid UNIQUE table constraint. */
    it("creates the case-insensitive username index", async () => {
      const rows = await db.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = $1 AND indexname = 'users_hospital_username_key'`,
        [SCHEMA],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toContain("lower(username)");
    });

    it("applies nothing on a second run", async () => {
      const outcome = await migrate(db, loadMigrations());
      expect(outcome.applied).toEqual([]);
      expect(outcome.skipped).toHaveLength(5);
    }, 60_000);

    it("refuses to run when an applied migration has been edited", async () => {
      const tampered = loadMigrations().map((migration) =>
        migration.name === "002_session_tokens"
          ? { ...migration, sql: `${migration.sql}\n-- edited after the fact` }
          : migration,
      );
      await expect(migrate(db, tampered)).rejects.toThrow(MigrationIntegrityError);
    }, 60_000);
  });

  describe("seed", () => {
    it("accepts the rows every other test needs", async () => {
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO hospitals (id, name, code) VALUES ($1, $2, $3)`,
          [HOSPITAL, "Ikeja General Hospital", "IKJ"],
        );
        await tx.query(
          `INSERT INTO branches (id, hospital_id, name, code, is_default)
           VALUES ($1, $2, $3, $4, true)`,
          [BRANCH, HOSPITAL, "Main Branch", "MAIN"],
        );
        await tx.query(
          `INSERT INTO roles (id, hospital_id, key, name, permissions)
           VALUES ($1, $2, $3, $4, $5)`,
          [ROLE, HOSPITAL, "reception", "Reception", ["visit.create", "queue.call"]],
        );
        await tx.query(
          `INSERT INTO stations
             (id, branch_id, name, code, service_estimate_ms, sla_target_wait_ms,
              sla_saturation_point, queue_template)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [STATION, BRANCH, "Consultation", "CONS", 600_000, 1_200_000, 20, "A-{n:3}"],
        );
      });

      const [hospital] = await db.query<{ name: string }>(
        `SELECT name FROM hospitals WHERE id = $1`,
        [HOSPITAL],
      );
      expect(hospital!.name).toBe("Ikeja General Hospital");
    });
  });

  describe("account repository", () => {
    it("stores and reads an account with its role and branches", async () => {
      const password = await hashPassword("a reasonable passphrase", {
        N: 1024,
        r: 8,
        p: 1,
        keyLength: 64,
      });

      await db.query(
        `INSERT INTO users (id, hospital_id, role_id, display_name, username,
                            password_hash, password_salt)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [USER, HOSPITAL, ROLE, "Ifeoma Nwosu", "Ifeoma", password.hash, password.salt],
      );
      await db.query(
        `INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)`,
        [USER, BRANCH],
      );

      const accounts = new PostgresAccountRepository(db);
      const stored = await accounts.findByUsername(HOSPITAL, "IFEOMA");

      expect(stored).not.toBeNull();
      expect(stored!.account.displayName).toBe("Ifeoma Nwosu");
      // text[] must survive the round trip as a real array, not a string.
      expect(stored!.permissions).toEqual(["visit.create", "queue.call"]);
      expect(stored!.account.branchIds).toEqual([BRANCH]);
      expect(stored!.roleKey).toBe("reception");
    });

    /** Tenancy is enforced in the query, not the UI. */
    it("does not find an account in another hospital", async () => {
      const accounts = new PostgresAccountRepository(db);
      expect(
        await accounts.findByUsername("99999999-9999-9999-9999-999999999999", "ifeoma"),
      ).toBeNull();
    });

    it("refuses a second account differing only in capitalisation", async () => {
      await expect(
        db.query(
          `INSERT INTO users (id, hospital_id, role_id, display_name, username)
           VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
          [HOSPITAL, ROLE, "Impostor", "IFEOMA"],
        ),
      ).rejects.toThrow();
    });

    it("updates a password in place", async () => {
      const accounts = new PostgresAccountRepository(db);
      await accounts.updatePassword(UserId(USER), "scrypt$16384$8$1$aa", "bb", new Date());
      const stored = await accounts.findById(UserId(USER));
      expect(stored!.passwordHash).toBe("scrypt$16384$8$1$aa");
    });
  });

  describe("session repository", () => {
    const session = (id: string): Session => ({
      id,
      userId: UserId(USER),
      branchId: null,
      providerId: "local",
      startedAt: new Date(),
      lastActiveAt: new Date(),
      endedAt: null,
      endReason: null,
      device: "Chrome on Windows",
      userAgent: "Mozilla/5.0",
    });

    it("finds a session by the hash of its token", async () => {
      const sessions = new PostgresSessionRepository(db);
      const token = issueToken();
      const opened = session("aaaaaaaa-1111-1111-1111-111111111111");

      await sessions.create(opened, hashToken(token));
      const found = await sessions.findByToken(hashToken(token));

      expect(found?.id).toBe(opened.id);
      expect(await sessions.findByToken(hashToken(issueToken()))).toBeNull();
    });

    /** A signed-out session that still resolves is one that still works. */
    it("stops finding a session once it has ended", async () => {
      const sessions = new PostgresSessionRepository(db);
      const token = issueToken();
      const opened = session("aaaaaaaa-2222-2222-2222-222222222222");
      await sessions.create(opened, hashToken(token));

      opened.endedAt = new Date();
      opened.endReason = "signed_out";
      await sessions.save(opened);

      expect(await sessions.findByToken(hashToken(token))).toBeNull();
    });

    it("ends every session a user holds", async () => {
      const sessions = new PostgresSessionRepository(db);
      await sessions.create(session("aaaaaaaa-3333-3333-3333-333333333333"), hashToken(issueToken()));
      await sessions.create(session("aaaaaaaa-4444-4444-4444-444444444444"), hashToken(issueToken()));

      const ended = await sessions.endAllForUser(UserId(USER), "terminated_by_admin", new Date());
      expect(ended).toBeGreaterThanOrEqual(2);
    });
  });

  describe("lockout repository", () => {
    it("round-trips a rolling window of failure times", async () => {
      const lockouts = new PostgresLockoutRepository(db);
      const first = new Date("2026-03-09T09:00:00Z");
      const second = new Date("2026-03-09T09:01:00Z");

      await lockouts.set(HOSPITAL, "Ifeoma", { failures: [first, second], lockedUntil: null }, first);
      const state = await lockouts.get(HOSPITAL, "ifeoma");

      // timestamptz[] must come back as Dates, in order.
      expect(state.failures.map((at) => at.toISOString())).toEqual([
        first.toISOString(),
        second.toISOString(),
      ]);
      expect(state.lockedUntil).toBeNull();
    });

    it("overwrites rather than accumulating rows", async () => {
      const lockouts = new PostgresLockoutRepository(db);
      const at = new Date("2026-03-09T10:00:00Z");
      const until = new Date("2026-03-09T10:15:00Z");

      await lockouts.set(HOSPITAL, "ifeoma", { failures: [], lockedUntil: until }, at);
      const state = await lockouts.get(HOSPITAL, "ifeoma");

      expect(state.lockedUntil?.toISOString()).toBe(until.toISOString());
      const counted = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM login_throttle WHERE hospital_id = $1`,
        [HOSPITAL],
      );
      expect(counted[0]!.count).toBe("1");
    });

    /** A stale row still holding a lock must survive, or waiting clears a lockout. */
    it("keeps a locked row when pruning stale ones", async () => {
      const lockouts = new PostgresLockoutRepository(db);
      const long = new Date("2099-01-01T00:00:00Z");
      await lockouts.set(HOSPITAL, "locked-user", { failures: [], lockedUntil: long }, new Date(0));

      await lockouts.prune(new Date("2030-01-01T00:00:00Z"));
      expect((await lockouts.get(HOSPITAL, "locked-user")).lockedUntil).not.toBeNull();
    });
  });

  describe("idempotency repository", () => {
    it("claims, completes and replays", async () => {
      const keys = new PostgresIdempotencyRepository(db);
      const at = new Date();

      expect((await keys.claim(HOSPITAL, "k-1", "print", at)).outcome).toBe("claimed");
      expect((await keys.claim(HOSPITAL, "k-1", "print", at)).outcome).toBe("in_flight");

      await keys.complete(HOSPITAL, "k-1", 200, { visit: { id: "v1" } }, at);
      const replay = await keys.claim(HOSPITAL, "k-1", "print", at);

      expect(replay).toEqual({
        outcome: "replay",
        statusCode: 200,
        response: { visit: { id: "v1" } },
      });
    });

    it("detects a key reused for a different request", async () => {
      const keys = new PostgresIdempotencyRepository(db);
      const at = new Date();
      await keys.claim(HOSPITAL, "k-2", "print-a", at);
      await keys.complete(HOSPITAL, "k-2", 200, {}, at);

      expect((await keys.claim(HOSPITAL, "k-2", "print-b", at)).outcome).toBe("mismatch");
    });

    /**
     * The race the claim exists to close. Concurrent retries of one request must
     * produce exactly one winner.
     */
    it("gives exactly one caller the claim under concurrency", async () => {
      const keys = new PostgresIdempotencyRepository(db);
      const at = new Date();

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () => keys.claim(HOSPITAL, "k-race", "print", at)),
      );

      expect(outcomes.filter((o) => o.outcome === "claimed")).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === "in_flight")).toHaveLength(19);
    });
  });

  describe("ticket allocation under concurrency", () => {
    /**
     * The single most important guarantee in the system. Two receptions
     * admitting patients at the same moment must not both be handed A-014, and
     * a read-then-write would do exactly that. This runs from separate pool
     * connections, which is the only way the race is real.
     */
    it("never issues the same ordinal twice", async () => {
      const allocator = new PostgresTicketAllocator(db);
      const attempts = 50;

      const ordinals = await Promise.all(
        Array.from({ length: attempts }, () => allocator.next(STATION as never, "2026-03-09")),
      );

      expect(new Set(ordinals).size).toBe(attempts);
      expect([...ordinals].sort((a, b) => a - b)).toEqual(
        Array.from({ length: attempts }, (_, i) => i + 1),
      );
    }, 60_000);

    it("keeps separate series per period", async () => {
      const allocator = new PostgresTicketAllocator(db);
      expect(await allocator.next(STATION as never, "2026-03-10")).toBe(1);
      expect(await allocator.next(STATION as never, "2026-03-10")).toBe(2);
      expect(await allocator.next(STATION as never, "2026-03-09")).toBe(51);
    });

    /**
     * `advanceTo` takes the next ordinal that is safe to issue, not the highest
     * one already issued — so a caller cannot set a counter to a number still
     * in a patient's hand. After advancing to 500, the next ticket *is* 500.
     */
    it("advances a series so the next ticket is the one asked for", async () => {
      const allocator = new PostgresTicketAllocator(db);
      await allocator.advanceTo(STATION as never, "2026-03-10", 500);
      expect(await allocator.next(STATION as never, "2026-03-10")).toBe(500);
    });

    /**
     * Recovery run twice, or with a stale figure, must never wind a series
     * backwards — reissuing a ticket someone is already holding is the failure
     * the whole recovery path exists to prevent.
     */
    it("ignores an attempt to wind a series backwards", async () => {
      const allocator = new PostgresTicketAllocator(db);
      await allocator.advanceTo(STATION as never, "2026-03-10", 10);
      expect(await allocator.next(STATION as never, "2026-03-10")).toBe(501);
    });
  });

  describe("configuration repository", () => {
    it("assembles the whole configuration in one read", async () => {
      const configuration = await new PostgresConfigurationRepository(db).load(HOSPITAL);

      expect(configuration).not.toBeNull();
      expect(configuration!.profile.name).toBe("Ikeja General Hospital");
      expect(configuration!.branches.map((b) => b.code)).toContain("MAIN");
      expect(configuration!.stations.map((s) => s.name)).toContain("Consultation");
      // Nested value assembled from three columns, so a mapping slip shows.
      expect(configuration!.stations[0]!.sla.targetWaitMillis).toBe(1_200_000);
      expect(configuration!.stations[0]!.queueNumber.template).toBe("A-{n:3}");
    });

    it("returns null for a hospital that does not exist", async () => {
      const configuration = await new PostgresConfigurationRepository(db).load(
        "99999999-9999-9999-9999-999999999999",
      );
      expect(configuration).toBeNull();
    });

    /** text[] of permission names must survive as an array, not a string. */
    it("reads roles with their permission grants", async () => {
      const roles = await new PostgresConfigurationRepository(db).loadRoles(HOSPITAL);
      expect(roles).toHaveLength(1);
      expect(roles[0]!.permissions).toEqual(["visit.create", "queue.call"]);
      expect(roles[0]!.name).toBe("Reception");
    });
  });

  describe("configuration writer", () => {
    const writer = new PostgresConfigurationWriter();

    it("persists a station change and reads it back", async () => {
      const repository = new PostgresConfigurationRepository(db);
      const before = await repository.load(HOSPITAL);
      const station = before!.stations[0]!;

      await db.transaction((tx) =>
        writer.updateStation(
          tx,
          {
            ...station,
            name: "Consultation A",
            sla: { targetWaitMillis: 900_000, saturationPoint: 15 },
          },
          new Date(),
        ),
      );

      const after = await repository.load(HOSPITAL);
      expect(after!.stations[0]!.name).toBe("Consultation A");
      expect(after!.stations[0]!.sla.targetWaitMillis).toBe(900_000);
      // Untouched fields must survive a partial edit.
      expect(after!.stations[0]!.queueNumber.template).toBe("A-{n:3}");
    });

    /**
     * The whole point of the transaction. A write that fails after another has
     * already landed must leave neither.
     */
    it("leaves nothing behind when the unit of work fails", async () => {
      const repository = new PostgresConfigurationRepository(db);
      const station = (await repository.load(HOSPITAL))!.stations[0]!;

      await expect(
        db.transaction(async (tx) => {
          await writer.updateStation(tx, { ...station, name: "Rolled Back" }, new Date());
          throw new Error("validation failed after the write");
        }),
      ).rejects.toThrow();

      const after = await repository.load(HOSPITAL);
      expect(after!.stations[0]!.name).toBe("Consultation A");
    });

    it("upserts hospital defaults whether or not a row exists", async () => {
      const repository = new PostgresConfigurationRepository(db);

      await db.transaction((tx) =>
        writer.updateDefaults(
          tx,
          HOSPITAL,
          { namePolicy: "first_name", ticketTemplateId: "t-1" },
          new Date(),
        ),
      );
      expect((await repository.load(HOSPITAL))!.defaults.namePolicy).toBe("first_name");

      await db.transaction((tx) =>
        writer.updateDefaults(
          tx,
          HOSPITAL,
          { namePolicy: "ticket_only", ticketTemplateId: "t-2" },
          new Date(),
        ),
      );
      const after = await repository.load(HOSPITAL);
      expect(after!.defaults.namePolicy).toBe("ticket_only");
      expect(after!.defaults.ticketTemplateId).toBe("t-2");
    });

    it("persists the profile", async () => {
      const repository = new PostgresConfigurationRepository(db);
      const profile = (await repository.load(HOSPITAL))!.profile;

      await db.transaction((tx) =>
        writer.updateProfile(tx, { ...profile, name: "Ikeja General" }, new Date()),
      );

      expect((await repository.load(HOSPITAL))!.profile.name).toBe("Ikeja General");
    });
  });

  describe("board directory", () => {
    it("resolves a board to its branch and stations", async () => {
      const boardId = "77777777-7777-7777-7777-777777777777";
      await db.query(
        `INSERT INTO display_boards (id, branch_id, name, station_ids)
         VALUES ($1, $2, $3, $4)`,
        [boardId, BRANCH, "Main Waiting Area", [STATION]],
      );

      const board = await new PostgresBoardDirectory(db).find(boardId);
      expect(board?.branchId).toBe(BRANCH);
      expect(board?.stationIds).toEqual([STATION]);
      expect(await new PostgresBoardDirectory(db).find(
        "88888888-8888-8888-8888-888888888888",
      )).toBeNull();
    });
  });

  describe("transactions", () => {
    /**
     * The adapter's central claim, and the one a fake cannot prove: a failed
     * unit of work leaves nothing behind.
     */
    it("rolls back every statement when the work throws", async () => {
      const before = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM branches`,
      );

      await expect(
        db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO branches (hospital_id, name, code) VALUES ($1, $2, $3)`,
            [HOSPITAL, "Rolled Back", "RB1"],
          );
          throw new Error("the domain rejected this");
        }),
      ).rejects.toThrow("the domain rejected this");

      const after = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM branches`,
      );
      expect(after[0]!.count).toBe(before[0]!.count);
    });

    it("commits every statement when the work succeeds", async () => {
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO branches (hospital_id, name, code) VALUES ($1, $2, $3)`,
          [HOSPITAL, "Committed", "CM1"],
        );
      });

      const rows = await db.query(`SELECT id FROM branches WHERE code = 'CM1'`);
      expect(rows).toHaveLength(1);
    });

    /**
     * A connection returned to the pool mid-transaction hands the next caller
     * an open one. Interleaving proves each unit of work is isolated.
     */
    it("keeps concurrent units of work from seeing each other", async () => {
      const results = await Promise.all([
        db.transaction(async (tx) => {
          await tx.query(`INSERT INTO branches (hospital_id, name, code) VALUES ($1,$2,$3)`, [
            HOSPITAL,
            "Concurrent A",
            "CA1",
          ]);
          return "a";
        }),
        db.transaction(async (tx) => {
          await tx.query(`INSERT INTO branches (hospital_id, name, code) VALUES ($1,$2,$3)`, [
            HOSPITAL,
            "Concurrent B",
            "CB1",
          ]);
          return "b";
        }),
      ]);

      expect(results).toEqual(["a", "b"]);
      const rows = await db.query(`SELECT code FROM branches WHERE code IN ('CA1','CB1')`);
      expect(rows).toHaveLength(2);
    });
  });
});
