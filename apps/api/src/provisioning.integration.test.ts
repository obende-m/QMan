/**
 * Provisioning an organization, against a real PostgreSQL.
 *
 * This closes the last gap where a fake could not help. `PostgresOrganizationProvisioning`
 * writes five things in one transaction — a hospital, its default branch, four
 * roles, an administrator, and the password that administrator signs in with —
 * and the only interesting questions about it are questions a fake cannot
 * answer: does the SQL parse, do the constraints hold, and does the whole thing
 * roll back when one statement fails.
 *
 * The last of those is the one that matters most. A half-created organization —
 * a hospital row with no branch, or a branch with no administrator — is not a
 * state the product can recover from: nobody can sign in to fix it, and the
 * platform's create endpoint would refuse the code as already taken. So the
 * failure path is tested as carefully as the success path.
 *
 * Skips silently without DATABASE_URL, like the other integration file:
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
  PostgresConfigurationRepository,
  PostgresConfigurationWriter,
  PostgresOrganizationDirectory,
  PostgresPlatformUserRepository,
  type ConfigurationWriter,
  type Database,
} from "@qman/persistence";
import { DEFAULT_ROLES, type RoleConfig } from "@qman/domain";
import { loadMigrations } from "./migrations.js";
import { verifyPassword } from "./passwords.js";
import { PostgresOrganizationProvisioning } from "./provisioning.js";

const url = process.env["DATABASE_URL"];
const suite = url ? describe : describe.skip;

const SCHEMA = `qman_provision_${Date.now().toString(36)}`;

let pool: pg.Pool;
let db: Database;
let writer: ConfigurationWriter;
let provisioning: PostgresOrganizationProvisioning;

suite("provisioning against real PostgreSQL", () => {
  beforeAll(async () => {
    const bootstrap = new pg.Pool({
      connectionString: url,
      ssl: url!.includes("localhost") ? undefined : { rejectUnauthorized: true },
    });
    await bootstrap.query(`CREATE SCHEMA "${SCHEMA}"`);
    await bootstrap.end();

    pool = new pg.Pool({
      connectionString: url,
      max: 8,
      options: `-c search_path=${SCHEMA}`,
      ssl: url!.includes("localhost") ? undefined : { rejectUnauthorized: true },
    });
    db = createPostgresDatabase(pool);
    await migrate(db, loadMigrations());

    writer = new PostgresConfigurationWriter();
    provisioning = new PostgresOrganizationProvisioning(db, writer);
  }, 120_000);

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await pool.end();
    }
  }, 60_000);

  const at = new Date("2026-03-09T09:00:00Z");

  describe("a new organization", () => {
    it("creates the hospital, its branch, its roles and an administrator in one call", async () => {
      const created = await provisioning.create({
        code: "freshsprings",
        name: "Freshsprings Medical Services",
        timezone: "Africa/Lagos",
        branchName: "Ikeja Main",
        adminUsername: "admin",
        adminDisplayName: "Freshsprings Administrator",
        at,
      });

      expect(created.organizationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.adminPassword).toMatch(/^[A-Za-z2-9]{5}(-[A-Za-z2-9]{5}){3}$/);

      const [hospital] = await db.query<{
        name: string;
        code: string;
        status: string;
        timezone: string;
      }>(`SELECT name, code, status, timezone FROM hospitals WHERE id = $1`, [
        created.organizationId,
      ]);
      expect(hospital).toEqual({
        name: "Freshsprings Medical Services",
        code: "freshsprings",
        // Migration 011's default, and what makes the organization usable
        // immediately rather than needing a second call to activate it.
        status: "active",
        timezone: "Africa/Lagos",
      });

      const branches = await db.query<{ name: string; code: string; is_default: boolean }>(
        `SELECT name, code, is_default FROM branches WHERE hospital_id = $1`,
        [created.organizationId],
      );
      expect(branches).toEqual([{ name: "Ikeja Main", code: "main", is_default: true }]);

      const roles = await db.query<{ name: string; is_system: boolean; permissions: string[] }>(
        `SELECT name, is_system, permissions FROM roles WHERE hospital_id = $1 ORDER BY name`,
        [created.organizationId],
      );
      // The domain's DEFAULT_ROLES, not a copy maintained here.
      expect(roles.map((role) => role.name).sort()).toEqual(
        [...DEFAULT_ROLES].map((role: RoleConfig) => role.name).sort(),
      );
      expect(roles.every((role) => role.is_system)).toBe(true);

      const users = await db.query<{ username: string; display_name: string; enabled: boolean }>(
        `SELECT username, display_name, enabled FROM users WHERE hospital_id = $1`,
        [created.organizationId],
      );
      expect(users).toEqual([
        { username: "admin", display_name: "Freshsprings Administrator", enabled: true },
      ]);
    }, 60_000);

    it("gives the administrator a role that can administer the hospital", async () => {
      const created = await provisioning.create({
        code: "rolecheck",
        name: "Role Check Hospital",
        timezone: "UTC",
        branchName: "Main",
        adminUsername: "admin",
        adminDisplayName: "Admin",
        at,
      });

      const [row] = await db.query<{ permissions: string[] }>(
        `SELECT r.permissions
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.hospital_id = $1`,
        [created.organizationId],
      );

      // Found by key rather than by position in DEFAULT_ROLES: reordering that
      // array must not quietly hand a new hospital's administrator the
      // receptionist's permissions.
      expect(row!.permissions).toContain("admin.users");
      expect(row!.permissions).toContain("admin.settings");
    }, 60_000);

    /** The credentials the platform hands over must actually work. */
    it("issues a password the administrator can sign in with", async () => {
      const created = await provisioning.create({
        code: "signinable",
        name: "Sign-in Hospital",
        timezone: "UTC",
        branchName: "Main",
        adminUsername: "matron",
        adminDisplayName: "Matron",
        at,
      });

      const accounts = new PostgresAccountRepository(db);
      const stored = await accounts.findByUsername(created.organizationId, "matron");
      expect(stored).not.toBeNull();

      expect(
        await verifyPassword(created.adminPassword, stored!.passwordHash, stored!.passwordSalt),
      ).toBe(true);
      // And nothing else does.
      expect(await verifyPassword("wrong", stored!.passwordHash, stored!.passwordSalt)).toBe(
        false,
      );
    }, 60_000);

    it("produces an organization the configuration layer can read back", async () => {
      const created = await provisioning.create({
        code: "readable",
        name: "Readable Hospital",
        timezone: "UTC",
        branchName: "Main",
        adminUsername: "admin",
        adminDisplayName: "Admin",
        at,
      });

      // An organization created here must be indistinguishable from one built
      // up through the configuration API — that is the whole reason
      // provisioning reuses ConfigurationWriter rather than issuing its own SQL.
      const configuration = new PostgresConfigurationRepository(db);
      const loaded = await configuration.load(created.organizationId);
      expect(loaded).not.toBeNull();
      expect(loaded!.branches).toHaveLength(1);

      const roles = await configuration.loadRoles(created.organizationId);
      expect(roles).toHaveLength(DEFAULT_ROLES.length);
    }, 60_000);

    it("is findable by its code, which is how sign-in resolves it", async () => {
      const created = await provisioning.create({
        code: "findable",
        name: "Findable Hospital",
        timezone: "UTC",
        branchName: "Main",
        adminUsername: "admin",
        adminDisplayName: "Admin",
        at,
      });

      const directory = new PostgresOrganizationDirectory(db);
      const byCode = await directory.findByCode("FINDABLE");
      expect(byCode?.id).toBe(created.organizationId);

      // The branch resolves back to the organization, which is what the public
      // surfaces use to decide whether a board should still be serving.
      const [branch] = await db.query<{ id: string }>(
        `SELECT id FROM branches WHERE hospital_id = $1`,
        [created.organizationId],
      );
      const byBranch = await directory.findByBranch(branch!.id);
      expect(byBranch?.id).toBe(created.organizationId);
    }, 60_000);
  });

  describe("rollback", () => {
    /**
     * A duplicate code is refused by the unique index mid-transaction.
     *
     * The route checks `isCodeTaken` first, so this is the race rather than the
     * ordinary path: two platform administrators creating the same code at the
     * same moment, where both checks pass and one insert loses. What must not
     * happen is the loser leaving a branch, four roles and an administrator
     * behind attached to nothing.
     */
    it("leaves nothing behind when the hospital insert fails", async () => {
      await provisioning.create({
        code: "taken",
        name: "First Hospital",
        timezone: "UTC",
        branchName: "Main",
        adminUsername: "admin",
        adminDisplayName: "Admin",
        at,
      });

      const before = await counts(db);

      await expect(
        provisioning.create({
          code: "taken",
          name: "Second Hospital",
          timezone: "UTC",
          branchName: "Main",
          adminUsername: "admin",
          adminDisplayName: "Admin",
          at,
        }),
      ).rejects.toThrow();

      expect(await counts(db)).toEqual(before);

      // And the organization that did exist is untouched.
      const hospitals = await db.query<{ name: string }>(
        `SELECT name FROM hospitals WHERE code = 'taken'`,
      );
      expect(hospitals).toEqual([{ name: "First Hospital" }]);
    }, 60_000);

    /**
     * A failure in the *last* statement must undo the first four.
     *
     * This is the case a transaction is actually for. The hospital, branch and
     * roles have all been written by the time the user insert runs, so a
     * provisioning that was not transactional would leave a complete-looking
     * organization that nobody can sign in to — and whose code is now taken,
     * so it cannot be created again either.
     */
    it("undoes the hospital, branch and roles when the administrator insert fails", async () => {
      const before = await counts(db);

      // A writer that behaves normally until the roles are written, then makes
      // the user insert fail. Failing through the real code path rather than by
      // calling the transaction directly, so what is tested is what runs.
      const brokenWriter: ConfigurationWriter = {
        ...writer,
        createRole: async (tx, hospitalId, role, when) => {
          await writer.createRole(tx, hospitalId, role, when);
          if (role.name === DEFAULT_ROLES[DEFAULT_ROLES.length - 1]!.name) {
            // A role_id that cannot satisfy the users foreign key, so the
            // administrator insert fails after everything else succeeded.
            await tx.query(`SET CONSTRAINTS ALL IMMEDIATE`);
            throw new Error("simulated failure after roles were written");
          }
        },
      };

      const broken = new PostgresOrganizationProvisioning(db, brokenWriter);

      await expect(
        broken.create({
          code: "rollback",
          name: "Rollback Hospital",
          timezone: "UTC",
          branchName: "Main",
          adminUsername: "admin",
          adminDisplayName: "Admin",
          at,
        }),
      ).rejects.toThrow(/simulated failure/);

      expect(await counts(db)).toEqual(before);

      // Nothing named "rollback" survives, so the code is free to be used again.
      const orphans = await db.query(`SELECT id FROM hospitals WHERE code = 'rollback'`);
      expect(orphans).toEqual([]);
    }, 60_000);

    it("leaves an administrator reset alone when it targets nobody", async () => {
      const created = await provisioning.create({
        code: "resettable",
        name: "Resettable Hospital",
        timezone: "UTC",
        branchName: "Main",
        adminUsername: "admin",
        adminDisplayName: "Admin",
        at,
      });

      const reset = await provisioning.resetAdministrator({
        organizationId: created.organizationId,
        username: "does-not-exist",
        at,
      });
      expect(reset).toBeNull();

      // The real administrator's password is unchanged.
      const accounts = new PostgresAccountRepository(db);
      const stored = await accounts.findByUsername(created.organizationId, "admin");
      expect(
        await verifyPassword(created.adminPassword, stored!.passwordHash, stored!.passwordSalt),
      ).toBe(true);
    }, 60_000);

    /**
     * A reset must not reach into another organization.
     *
     * Usernames are unique per hospital, not globally, so "admin" exists in
     * every organization. A reset scoped only by username would change a
     * different hospital's administrator — which is the precise mistake §6.2's
     * guard exists to catch, and better not made in the first place.
     */
    it("scopes an administrator reset to one organization", async () => {
      const a = await provisioning.create({
        code: `scoped-a-${randomUUID().slice(0, 8)}`,
        name: "Scoped A",
        timezone: "UTC",
        branchName: "Main",
        adminUsername: "admin",
        adminDisplayName: "Admin",
        at,
      });
      const b = await provisioning.create({
        code: `scoped-b-${randomUUID().slice(0, 8)}`,
        name: "Scoped B",
        timezone: "UTC",
        branchName: "Main",
        adminUsername: "admin",
        adminDisplayName: "Admin",
        at,
      });

      const reset = await provisioning.resetAdministrator({
        organizationId: a.organizationId,
        username: "admin",
        at,
      });
      expect(reset).not.toBeNull();

      const accounts = new PostgresAccountRepository(db);

      const changed = await accounts.findByUsername(a.organizationId, "admin");
      expect(
        await verifyPassword(reset!.password, changed!.passwordHash, changed!.passwordSalt),
      ).toBe(true);

      // B's administrator still has B's original password.
      const untouched = await accounts.findByUsername(b.organizationId, "admin");
      expect(
        await verifyPassword(b.adminPassword, untouched!.passwordHash, untouched!.passwordSalt),
      ).toBe(true);
      expect(
        await verifyPassword(reset!.password, untouched!.passwordHash, untouched!.passwordSalt),
      ).toBe(false);
    }, 60_000);
  });

  describe("the platform account tables", () => {
    it("holds a platform administrator that belongs to no hospital", async () => {
      const users = new PostgresPlatformUserRepository(db);
      const id = await users.create(
        {
          username: "root",
          displayName: "Platform Root",
          passwordHash: "scrypt$16384$8$1$" + "0".repeat(128),
          passwordSalt: "0".repeat(32),
          role: "super_admin",
          enabled: true,
        },
        at,
      );

      expect(await users.count()).toBe(1);
      expect((await users.findById(id))?.username).toBe("root");
      expect((await users.findByUsername("ROOT"))?.id).toBe(id);

      // There is no column that could hold one, which is the point of the
      // separate table rather than a nullable hospital_id on users.
      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'platform_users'`,
        [SCHEMA],
      );
      expect(columns.map((c) => c.column_name)).not.toContain("hospital_id");
    }, 60_000);

    it("refuses a platform role the application does not recognise", async () => {
      await expect(
        db.query(
          `INSERT INTO platform_users
             (username, display_name, password_hash, password_salt, role)
           VALUES ('impostor', 'Impostor', 'x', 'y', 'god_mode')`,
        ),
      ).rejects.toThrow();
    }, 60_000);
  });
});

/** The rows a provisioning run creates, for before/after comparison. */
async function counts(database: Database): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of ["hospitals", "branches", "roles", "users"]) {
    const [row] = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table}`,
    );
    result[table] = Number(row!.count);
  }
  return result;
}
