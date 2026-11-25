/**
 * Platform administration, tenant isolation, and suspension.
 *
 * The four properties this file exists to hold, all of which are security
 * properties rather than features:
 *
 *  1. Organization A cannot reach organization B's data.
 *  2. A suspended organization cannot authenticate, and its public surfaces
 *     stop serving.
 *  3. An organization administrator cannot obtain a platform permission.
 *  4. A platform administrator does not become an organization administrator by
 *     holding a platform session.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALL_PLATFORM_PERMISSIONS,
  UserId,
  validateRoles,
  type RoleConfig,
  type Session,
} from "@qman/domain";
import type {
  AccountRepository,
  PlatformEventRepository,
  PlatformSession,
  PlatformSessionRepository,
  PlatformUserRepository,
  SessionRepository,
  StoredAccount,
  StoredPlatformUser,
  NewPlatformEvent,
  PlatformEventRecord,
} from "@qman/persistence";
import { AuthService, createMemoryLockoutStore } from "./auth.js";
import { fakeOrganizations, FAST, ORIGIN, PASSWORD } from "./config-fixtures.js";
import { createLogger } from "./logging.js";
import { hashPassword } from "./passwords.js";
import { PlatformAuthService } from "./platform-auth.js";
import { PLATFORM_SESSION_COOKIE } from "./platform-authorization.js";
import type { OrganizationProvisioning } from "./platform-routes.js";
import { CSRF_COOKIE } from "./csrf.js";
import { buildServer, SESSION_COOKIE } from "./server.js";

const HOSPITAL_A = "11111111-1111-1111-1111-111111111111";
const HOSPITAL_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// ────────────────────────────────────────────────────────────────── fakes

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
  async find(id: string) {
    return this.rows.get(id)?.session ?? null;
  }
  async findByToken(tokenHash: string) {
    for (const row of this.rows.values()) {
      if (row.tokenHash === tokenHash && row.session.endedAt === null) return row.session;
    }
    return null;
  }
  async create(session: Session, tokenHash: string) {
    this.rows.set(session.id, { session, tokenHash });
  }
  async activeForHospital() {
    return [];
  }
  async save(session: Session) {
    const row = this.rows.get(session.id);
    if (row) this.rows.set(session.id, { ...row, session });
  }
  async endAllForUser() {
    return 0;
  }
}

class FakePlatformUsers implements PlatformUserRepository {
  readonly rows: StoredPlatformUser[] = [];
  async findByUsername(username: string) {
    return this.rows.find((r) => r.username.toLowerCase() === username.toLowerCase()) ?? null;
  }
  async findById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async count() {
    return this.rows.length;
  }
  async create(user: Omit<StoredPlatformUser, "id">) {
    const id = `platform-${this.rows.length + 1}`;
    this.rows.push({ ...user, id });
    return id;
  }
  async updatePassword() {}
}

class FakePlatformSessions implements PlatformSessionRepository {
  readonly rows = new Map<string, { session: PlatformSession; tokenHash: string }>();
  #next = 0;
  async findByToken(tokenHash: string) {
    for (const row of this.rows.values()) {
      if (row.tokenHash === tokenHash && row.session.endedAt === null) return row.session;
    }
    return null;
  }
  async create(session: Omit<PlatformSession, "id">, tokenHash: string) {
    const created = { ...session, id: `psession-${(this.#next += 1)}` };
    this.rows.set(created.id, { session: created, tokenHash });
    return created;
  }
  async touch() {}
  async end(id: string, reason: string, at: Date) {
    const row = this.rows.get(id);
    if (row) {
      this.rows.set(id, {
        ...row,
        session: { ...row.session, endedAt: at, endReason: reason },
      });
    }
  }
  async endAllForUser() {
    return 0;
  }
}

class FakePlatformEvents implements PlatformEventRepository {
  readonly rows: PlatformEventRecord[] = [];
  async append(event: NewPlatformEvent) {
    this.rows.push({ ...event, id: `pe-${this.rows.length + 1}`, sequence: this.rows.length + 1 });
  }
  async query(query: { targetHospitalId?: string; limit?: number } = {}) {
    const filtered =
      query.targetHospitalId === undefined
        ? this.rows
        : this.rows.filter((r) => r.targetHospitalId === query.targetHospitalId);
    return [...filtered].reverse();
  }
}

const provisioning: OrganizationProvisioning = {
  async create(input) {
    return { organizationId: `org-${input.code}`, adminPassword: "GENERATED-ONCE" };
  },
  async resetAdministrator(input) {
    return input.username === "nobody"
      ? null
      : { username: input.username, password: "RESET-ONCE" };
  },
};

async function account(
  hospitalId: string,
  username: string,
  permissions: string[],
): Promise<StoredAccount> {
  const stored = await hashPassword(PASSWORD, FAST);
  return {
    hospitalId,
    account: {
      id: UserId(`user-${hospitalId}-${username}`),
      displayName: username,
      username,
      providerId: "local",
      enabled: true,
      roleId: "role-1",
      branchIds: [],
    },
    roleKey: "administrator",
    permissions: permissions as never,
    passwordHash: stored.hash,
    passwordSalt: stored.salt,
  } as unknown as StoredAccount;
}

function harness(options: {
  accounts: FakeAccounts;
  organizations: ReturnType<typeof fakeOrganizations>;
  platformUsers: FakePlatformUsers;
  platformSessions: FakePlatformSessions;
  events: FakePlatformEvents;
}) {
  const now = () => new Date("2026-03-09T09:00:00Z");
  let counter = 0;

  const auth = new AuthService({
    accounts: options.accounts,
    sessions: new FakeSessions(),
    lockouts: createMemoryLockoutStore(),
    now,
    newId: () => `session-${(counter += 1)}`,
  });

  const platformAuth = new PlatformAuthService({
    users: options.platformUsers,
    sessions: options.platformSessions,
    lockouts: (() => {
      const states = new Map<string, never>();
      return {
        get: async (key) => states.get(key) ?? { failures: [], lockedUntil: null },
        set: async (key, state) => void states.set(key, state as never),
      };
    })(),
    now,
  });

  return buildServer({
    auth,
    organizations: options.organizations,
    platform: {
      auth: platformAuth,
      events: options.events,
      users: options.platformUsers,
      provisioning,
    },
    secureCookies: true,
    allowedOrigins: [ORIGIN],
    logger: createLogger({ write: () => {} }),
    now,
  });
}

function cookieFrom(header: string | string[] | undefined, name: string): string {
  const values = Array.isArray(header) ? header : [header ?? ""];
  const pair = values.find((value) => value.startsWith(name));
  return pair === undefined ? "" : pair.split(";")[0]!;
}

// ─────────────────────────────────────────────────────────────────── tests

describe("platform administration", () => {
  let accounts: FakeAccounts;
  let organizations: ReturnType<typeof fakeOrganizations>;
  let platformUsers: FakePlatformUsers;
  let platformSessions: FakePlatformSessions;
  let events: FakePlatformEvents;

  beforeEach(async () => {
    accounts = new FakeAccounts();
    organizations = fakeOrganizations([
      { id: HOSPITAL_A, code: "alpha", name: "Alpha Hospital" },
      { id: HOSPITAL_B, code: "beta", name: "Beta Hospital" },
    ]);
    platformUsers = new FakePlatformUsers();
    platformSessions = new FakePlatformSessions();
    events = new FakePlatformEvents();

    const stored = await hashPassword(PASSWORD, FAST);
    platformUsers.rows.push({
      id: "platform-1",
      username: "root",
      displayName: "Platform Root",
      passwordHash: stored.hash,
      passwordSalt: stored.salt,
      role: "super_admin",
      enabled: true,
    });
  });

  const app = () =>
    harness({ accounts, organizations, platformUsers, platformSessions, events });

  async function platformSignIn(server: ReturnType<typeof harness>) {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/platform/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "root", password: PASSWORD },
    });
    const session = cookieFrom(response.headers["set-cookie"], PLATFORM_SESSION_COOKIE);
    const csrfCookie = cookieFrom(response.headers["set-cookie"], CSRF_COOKIE);
    return {
      status: response.statusCode,
      // Both cookies, as a browser would send them: the double-submit check
      // compares the cookie against the header, so sending only one fails.
      cookie: `${session}; ${csrfCookie}`,
      csrf: decodeURIComponent(csrfCookie.slice(CSRF_COOKIE.length + 1)),
    };
  }

  async function organizationSignIn(
    server: ReturnType<typeof harness>,
    organization: string,
    username: string,
  ) {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { organization, username, password: PASSWORD },
    });
    return {
      status: response.statusCode,
      body: response.json(),
      cookie: cookieFrom(response.headers["set-cookie"], SESSION_COOKIE),
    };
  }

  // ───────────────────────────────────────────────────── platform sign-in

  it("signs a platform administrator in and reports their permissions", async () => {
    const server = app();
    const { status, cookie } = await platformSignIn(server);

    expect(status).toBe(200);
    expect(cookie).toContain(PLATFORM_SESSION_COOKIE);

    const me = await server.inject({
      method: "GET",
      url: "/api/v1/platform/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.permissions).toEqual([...ALL_PLATFORM_PERMISSIONS]);
  });

  it("answers an unknown platform username exactly as a wrong password", async () => {
    const server = app();
    const unknown = await server.inject({
      method: "POST",
      url: "/api/v1/platform/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ghost", password: PASSWORD },
    });
    const wrong = await server.inject({
      method: "POST",
      url: "/api/v1/platform/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "root", password: "not the password" },
    });

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it("refuses every platform route without a platform session", async () => {
    const server = app();
    for (const url of [
      "/api/v1/platform/organizations",
      "/api/v1/platform/audit",
      "/api/v1/platform/health",
    ]) {
      const response = await server.inject({ method: "GET", url });
      expect(response.statusCode).toBe(401);
    }
  });

  // ─────────────────────────────────── the two credentials never substitute

  it("refuses an organization session on a platform route", async () => {
    const server = app();
    accounts.accounts.push(await account(HOSPITAL_A, "admin-a", ["admin.users"]));
    const signedIn = await organizationSignIn(server, "alpha", "admin-a");
    expect(signedIn.status).toBe(200);

    // The organization cookie, presented as itself. There is no platform
    // session, so the platform guard finds nothing to resolve.
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/platform/organizations",
      headers: { cookie: signedIn.cookie },
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses an organization token presented as a platform cookie", async () => {
    const server = app();
    accounts.accounts.push(await account(HOSPITAL_A, "admin-a", ["admin.users"]));
    const signedIn = await organizationSignIn(server, "alpha", "admin-a");
    const token = signedIn.cookie.split("=")[1]!;

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/platform/organizations",
      headers: { cookie: `${PLATFORM_SESSION_COOKIE}=${token}` },
    });
    // Looked up in platform_sessions, where an organization token does not
    // exist. No check had to be remembered for this to hold.
    expect(response.statusCode).toBe(401);
  });

  it("does not make a platform administrator an organization administrator", async () => {
    const server = app();
    const { cookie } = await platformSignIn(server);

    // A platform session on an organization route. The organization guard
    // reads a different cookie entirely and finds no session.
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(401);
  });

  // ────────────────────────────────────── organization administrators are capped

  it("refuses to store a hospital role carrying a platform permission", () => {
    const smuggled = {
      id: "role-x",
      name: "Sneaky",
      description: "",
      // Sent over the wire, where the type is only a suggestion.
      permissions: ["admin.users", "platform.organizations.create"],
      isSystem: false,
    } as unknown as RoleConfig;

    const problems = validateRoles([smuggled]);
    expect(problems.join(" ")).toContain("platform.organizations.create");
    expect(problems.join(" ")).toContain("cannot be granted by a hospital");
  });

  it("keeps the two permission catalogues disjoint", async () => {
    const { PERMISSIONS } = await import("@qman/domain");
    for (const permission of ALL_PLATFORM_PERMISSIONS) {
      expect(Object.keys(PERMISSIONS)).not.toContain(permission);
    }
  });

  // ────────────────────────────────────────────────── two-hospital isolation

  it("scopes a session to the organization its account belongs to", async () => {
    const server = app();
    accounts.accounts.push(await account(HOSPITAL_A, "shared-name", ["admin.users"]));
    accounts.accounts.push(await account(HOSPITAL_B, "shared-name", ["admin.users"]));

    const a = await organizationSignIn(server, "alpha", "shared-name");
    const b = await organizationSignIn(server, "beta", "shared-name");

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Same username, two hospitals, two different accounts. The organization
    // code chose which, and the session carries the id from then on.
    expect(a.body.user.id).not.toBe(b.body.user.id);
  });

  it("refuses a username that exists only in another organization", async () => {
    const server = app();
    accounts.accounts.push(await account(HOSPITAL_A, "only-in-a", ["admin.users"]));

    const wrongOrganization = await organizationSignIn(server, "beta", "only-in-a");
    expect(wrongOrganization.status).toBe(401);
  });

  it("answers an unknown organization code as a failed sign-in, not a 404", async () => {
    const server = app();
    accounts.accounts.push(await account(HOSPITAL_A, "admin-a", ["admin.users"]));

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { organization: "no-such-hospital", username: "admin-a", password: PASSWORD },
    });

    // Distinguishing this from a wrong password would turn the form into an
    // oracle for which hospitals QMan hosts.
    expect(response.statusCode).toBe(401);
    expect(response.json().reason).toBe("invalid_credentials");
  });

  // ─────────────────────────────────────────────────────────────── suspension

  it("refuses sign-in to a suspended organization, and says why", async () => {
    const server = app();
    accounts.accounts.push(await account(HOSPITAL_A, "admin-a", ["admin.users"]));
    organizations.set(HOSPITAL_A, { status: "suspended", suspendedReason: "unpaid" });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { organization: "alpha", username: "admin-a", password: PASSWORD },
    });

    // The one place a specific message is right: these are staff whose employer
    // is in arrears, not attackers probing for accounts.
    expect(response.statusCode).toBe(403);
    expect(response.json().reason).toBe("organization_suspended");
  });

  it("leaves other organizations signing in while one is suspended", async () => {
    const server = app();
    accounts.accounts.push(await account(HOSPITAL_A, "admin-a", ["admin.users"]));
    accounts.accounts.push(await account(HOSPITAL_B, "admin-b", ["admin.users"]));
    organizations.set(HOSPITAL_A, { status: "suspended", suspendedReason: "unpaid" });

    const b = await organizationSignIn(server, "beta", "admin-b");
    expect(b.status).toBe(200);
  });

  it("suspends and reactivates through the platform API, with an audit record", async () => {
    const server = app();
    const { cookie, csrf } = await platformSignIn(server);
    const headers = { cookie, origin: ORIGIN, "x-csrf-token": csrf };

    const suspended = await server.inject({
      method: "POST",
      url: `/api/v1/platform/organizations/${HOSPITAL_A}/suspend`,
      headers,
      payload: { reason: "Unpaid invoices" },
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().organization.status).toBe("suspended");

    const reactivated = await server.inject({
      method: "POST",
      url: `/api/v1/platform/organizations/${HOSPITAL_A}/reactivate`,
      headers,
      payload: {},
    });
    expect(reactivated.statusCode).toBe(200);
    expect(reactivated.json().organization.status).toBe("active");

    const types = events.rows.map((event) => event.type);
    expect(types).toContain("platform.organization_suspended");
    expect(types).toContain("platform.organization_reactivated");

    // The audit record names the organization by its immutable id.
    const record = events.rows.find((e) => e.type === "platform.organization_suspended")!;
    expect(record.targetHospitalId).toBe(HOSPITAL_A);
    expect(record.summary).toContain("Unpaid invoices");
  });

  it("refuses to suspend without a reason", async () => {
    const server = app();
    const { cookie, csrf } = await platformSignIn(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/v1/platform/organizations/${HOSPITAL_A}/suspend`,
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      payload: {},
    });
    expect(response.statusCode).toBe(422);
  });

  // ─────────────────────────────────────────────────── creating organizations

  it("creates an organization and returns its administrator password once", async () => {
    const server = app();
    const { cookie, csrf } = await platformSignIn(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/platform/organizations",
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      payload: {
        code: "freshsprings",
        name: "Freshsprings Medical Services",
        adminUsername: "admin",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().administrator).toEqual({
      username: "admin",
      password: "GENERATED-ONCE",
    });
    expect(events.rows.map((e) => e.type)).toContain("platform.organization_created");
  });

  it("refuses an organization code that is already taken", async () => {
    const server = app();
    const { cookie, csrf } = await platformSignIn(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/platform/organizations",
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      payload: { code: "alpha", name: "Impostor", adminUsername: "admin" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("refuses a malformed organization code rather than normalising it away", async () => {
    const server = app();
    const { cookie, csrf } = await platformSignIn(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/platform/organizations",
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      payload: { code: "a b c!", name: "Spaces R Us", adminUsername: "admin" },
    });
    expect(response.statusCode).toBe(422);
  });

  // ────────────────────────────────────────────────────────── admin reset

  it("resets an organization administrator and returns the password once", async () => {
    const server = app();
    const { cookie, csrf } = await platformSignIn(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/v1/platform/organizations/${HOSPITAL_A}/admin-reset`,
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      payload: { username: "admin-a" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().administrator.password).toBe("RESET-ONCE");
    expect(events.rows.map((e) => e.type)).toContain("platform.organization_admin_reset");
  });

  it("reports an administrator that does not exist rather than inventing one", async () => {
    const server = app();
    const { cookie, csrf } = await platformSignIn(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/v1/platform/organizations/${HOSPITAL_A}/admin-reset`,
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      payload: { username: "nobody" },
    });
    expect(response.statusCode).toBe(404);
  });

  // ───────────────────────────────────────────────────────── audit and health

  it("reports platform health without exposing anyone inside an organization", async () => {
    const server = app();
    const { cookie } = await platformSignIn(server);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/platform/health",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.organizations.total).toBeGreaterThan(0);
    expect(body.platformAdministrators).toBe(1);
    // Counts only. No names, no usernames, nothing from inside a hospital.
    expect(JSON.stringify(body)).not.toContain("admin-a");
  });

  it("filters the audit log to one organization", async () => {
    const server = app();
    const { cookie, csrf } = await platformSignIn(server);
    const headers = { cookie, origin: ORIGIN, "x-csrf-token": csrf };

    await server.inject({
      method: "POST",
      url: `/api/v1/platform/organizations/${HOSPITAL_A}/suspend`,
      headers,
      payload: { reason: "A" },
    });
    await server.inject({
      method: "POST",
      url: `/api/v1/platform/organizations/${HOSPITAL_B}/suspend`,
      headers,
      payload: { reason: "B" },
    });

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/platform/audit?organizationId=${HOSPITAL_A}`,
      headers: { cookie },
    });

    const returned = response.json().events as Array<{ organizationId: string }>;
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.every((event) => event.organizationId === HOSPITAL_A)).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────── CSRF

  it("refuses a platform state change with no CSRF token", async () => {
    const server = app();
    const { cookie } = await platformSignIn(server);

    const response = await server.inject({
      method: "POST",
      url: `/api/v1/platform/organizations/${HOSPITAL_A}/suspend`,
      headers: { cookie, origin: ORIGIN },
      payload: { reason: "no token" },
    });

    // Without the double-submit check extending to the platform cookie, this
    // would have passed on the Origin header alone.
    expect(response.statusCode).toBe(403);
  });
});
