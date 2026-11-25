/**
 * Account, session and branch administration over HTTP.
 *
 * The repository is in memory and scoped by organization exactly as the SQL
 * is, so a request naming another organization's id is answered as the real
 * one would answer it. Audit records are read back from the recording
 * database, because "the change happened and nobody wrote it down" is the
 * failure these routes most need not to have.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { UserId, type BranchId, type Permission, type Session } from "@qman/domain";
import {
  FakeDatabase,
  type AdministrationRepository,
  type BranchSummary,
  type NewUser,
  type SessionSummary,
  type UserChanges,
  type UserSummary,
} from "@qman/persistence";
import type { AuthService, ResolvedSession } from "./auth.js";
import { BRANCH, FAST, FakeAccounts, HOSPITAL, ORIGIN, PASSWORD, fakeOrganizations } from "./config-fixtures.js";
import { hashPassword } from "./passwords.js";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, buildServer } from "./server.js";
import { silentLogger } from "./logging.js";

const OTHER_HOSPITAL = "99999999-9999-9999-9999-999999999999";
const ADMIN_ROLE = "a0000000-0000-4000-8000-000000000001";
const RECEPTION_ROLE = "a0000000-0000-4000-8000-000000000002";
const FOREIGN_ROLE = "a0000000-0000-4000-8000-000000000009";
const ADMIN_ID = "b0000000-0000-4000-8000-000000000001";
const NURSE_ID = "b0000000-0000-4000-8000-000000000002";
const FOREIGN_USER = "b0000000-0000-4000-8000-000000000009";
const FOREIGN_BRANCH = "c0000000-0000-4000-8000-000000000009";
const NOW = new Date("2026-03-09T09:00:00Z");

interface User extends UserSummary {
  hospitalId: string;
  hash: string;
  salt: string;
}

class MemoryAdministration implements AdministrationRepository {
  readonly roles = new Map<string, { hospitalId: string; permissions: Permission[] }>([
    [ADMIN_ROLE, { hospitalId: HOSPITAL, permissions: ["admin.users", "admin.settings"] }],
    [RECEPTION_ROLE, { hospitalId: HOSPITAL, permissions: ["visit.create"] }],
    [FOREIGN_ROLE, { hospitalId: OTHER_HOSPITAL, permissions: ["admin.users"] }],
  ]);
  readonly branches = new Map<string, { hospitalId: string; name: string; code: string; isDefault: boolean }>([
    [BRANCH, { hospitalId: HOSPITAL, name: "Main", code: "main", isDefault: true }],
    [FOREIGN_BRANCH, { hospitalId: OTHER_HOSPITAL, name: "Elsewhere", code: "main", isDefault: true }],
  ]);
  readonly users = new Map<string, User>();
  readonly sessions = new Map<string, { hospitalId: string; userId: string; ended: string | null }>();
  readonly lockoutsCleared: string[] = [];
  #n = 0;

  add(id: string, hospitalId: string, roleId: string, extra: Partial<User> = {}): void {
    this.users.set(id, {
      id,
      hospitalId,
      username: `user${id.slice(-2)}`,
      displayName: `User ${id.slice(-2)}`,
      roleId,
      roleName: "role",
      branchIds: [],
      enabled: true,
      providerId: "local",
      passwordChangeRequired: false,
      lastSignInAt: null,
      createdAt: NOW,
      lockedUntil: null,
      hash: "",
      salt: "",
      ...extra,
    });
  }

  async listUsers(hospitalId: string) {
    return [...this.users.values()].filter((u) => u.hospitalId === hospitalId);
  }
  async findUser(hospitalId: string, userId: string) {
    const user = this.users.get(userId);
    return user && user.hospitalId === hospitalId ? { ...user } : null;
  }
  async isUsernameTaken(hospitalId: string, username: string, except?: string) {
    return [...this.users.values()].some(
      (u) => u.hospitalId === hospitalId && u.username.toLowerCase() === username.toLowerCase() && u.id !== except,
    );
  }
  async rolePermissions(hospitalId: string, roleId: string) {
    const role = this.roles.get(roleId);
    return role && role.hospitalId === hospitalId ? role.permissions : null;
  }
  async branchesBelong(hospitalId: string, ids: readonly string[]) {
    return ids.every((id) => this.branches.get(id)?.hospitalId === hospitalId);
  }
  async countUserAdministrators(hospitalId: string, except?: string) {
    return [...this.users.values()].filter(
      (u) =>
        u.hospitalId === hospitalId &&
        u.enabled &&
        u.id !== except &&
        this.roles.get(u.roleId)?.permissions.includes("admin.users"),
    ).length;
  }
  async createUser(_tx: unknown, hospitalId: string, user: NewUser) {
    this.#n += 1;
    const id = `d0000000-0000-4000-8000-${String(this.#n).padStart(12, "0")}`;
    this.add(id, hospitalId, user.roleId, {
      username: user.username,
      displayName: user.displayName,
      branchIds: user.branchIds,
      passwordChangeRequired: true,
      hash: user.passwordHash,
      salt: user.passwordSalt,
    });
    return id;
  }
  async updateUser(_tx: unknown, hospitalId: string, userId: string, changes: UserChanges) {
    const user = this.users.get(userId);
    if (user?.hospitalId !== hospitalId) return false;
    if (!user) return false;
    Object.assign(user, {
      ...(changes.displayName !== undefined ? { displayName: changes.displayName } : {}),
      ...(changes.roleId !== undefined ? { roleId: changes.roleId } : {}),
      ...(changes.branchIds !== undefined ? { branchIds: changes.branchIds } : {}),
      ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
    });
    return true;
  }
  async setPassword(_tx: unknown, hospitalId: string, userId: string, hash: string, salt: string, required: boolean) {
    const user = this.users.get(userId);
    if (user?.hospitalId !== hospitalId) return false;
    if (!user) return false;
    Object.assign(user, { hash, salt, passwordChangeRequired: required });
    return true;
  }
  async clearLockout(_tx: unknown, _hospitalId: string, username: string) {
    this.lockoutsCleared.push(username);
  }
  async recordSignIn() {}
  async passwordChangeRequired() {
    return false;
  }
  async listSessions(hospitalId: string): Promise<SessionSummary[]> {
    return [...this.sessions.entries()]
      .filter(([, s]) => s.hospitalId === hospitalId && s.ended === null)
      .map(([id, s]) => ({
        id,
        userId: s.userId,
        displayName: "x",
        username: "x",
        branchId: null,
        device: "Chrome on Windows",
        startedAt: NOW,
        lastActiveAt: NOW,
      }));
  }
  async endSession(_tx: unknown, hospitalId: string, sessionId: string, reason: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.hospitalId !== hospitalId || session.ended !== null) return null;
    session.ended = reason;
    return session.userId;
  }
  async endSessionsForUser(_tx: unknown, hospitalId: string, userId: string, reason: string, _at: Date, keep?: string) {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.hospitalId === hospitalId && s.userId === userId && s.ended === null && id !== keep) {
        s.ended = reason;
        n += 1;
      }
    }
    return n;
  }
  async listBranches(hospitalId: string): Promise<BranchSummary[]> {
    return [...this.branches.entries()]
      .filter(([, b]) => b.hospitalId === hospitalId)
      .map(([id, b]) => ({ id, name: b.name, code: b.code, isDefault: b.isDefault }));
  }
  async isBranchCodeTaken(hospitalId: string, code: string, except?: string) {
    return [...this.branches.entries()].some(
      ([id, b]) => b.hospitalId === hospitalId && b.code.toLowerCase() === code.toLowerCase() && id !== except,
    );
  }
  async createBranch(_tx: unknown, hospitalId: string, branch: { name: string; code: string }) {
    const id = `e0000000-0000-4000-8000-00000000000${this.branches.size}`;
    this.branches.set(id, { hospitalId, ...branch, isDefault: false });
    return id;
  }
  async updateBranch(_tx: unknown, hospitalId: string, branchId: string, changes: { name?: string; code?: string; isDefault?: boolean }) {
    const branch = this.branches.get(branchId);
    if (!branch || branch.hospitalId !== hospitalId) return false;
    if (changes.isDefault) for (const b of this.branches.values()) if (b.hospitalId === hospitalId) b.isDefault = false;
    Object.assign(branch, changes);
    return true;
  }
}

interface Caller {
  userId: string;
  permissions: Permission[];
  passwordChangeRequired?: boolean;
}

function harness() {
  const repo = new MemoryAdministration();
  const db = new FakeDatabase();
  const accounts = new FakeAccounts();
  const callers = new Map<string, Caller>([
    ["admin", { userId: ADMIN_ID, permissions: ["admin.users", "admin.settings", "reports.view"] }],
    ["nurse", { userId: NURSE_ID, permissions: ["queue.call"] }],
    ["temporary", { userId: NURSE_ID, permissions: ["queue.call"], passwordChangeRequired: true }],
  ]);
  repo.add(ADMIN_ID, HOSPITAL, ADMIN_ROLE, { username: "admin" });
  repo.add(NURSE_ID, HOSPITAL, RECEPTION_ROLE, { username: "nurse" });
  repo.add(FOREIGN_USER, OTHER_HOSPITAL, FOREIGN_ROLE, { username: "foreign" });
  repo.sessions.set("f0000000-0000-4000-8000-000000000001", { hospitalId: HOSPITAL, userId: NURSE_ID, ended: null });
  repo.sessions.set("f0000000-0000-4000-8000-000000000009", { hospitalId: OTHER_HOSPITAL, userId: FOREIGN_USER, ended: null });

  const auth = {
    async resolve(token: string): Promise<ResolvedSession | null> {
      const caller = callers.get(token);
      if (!caller) return null;
      return {
        hospitalId: HOSPITAL,
        passwordChangeRequired: caller.passwordChangeRequired ?? false,
        session: { id: `f0000000-0000-4000-8000-0000000000${token.length}0`, userId: UserId(caller.userId), branchId: null } as unknown as Session,
        user: {
          account: {
            id: UserId(caller.userId),
            displayName: token,
            username: token,
            roleId: "r",
            branchIds: [] as BranchId[],
            providerId: "local",
            enabled: true,
          },
          permissions: caller.permissions,
          branchId: null,
        },
      } as unknown as ResolvedSession;
    },
    async signOut() {},
  } as unknown as AuthService;

  const app = buildServer({
    auth,
    organizations: fakeOrganizations(),
    secureCookies: true,
    allowedOrigins: [ORIGIN],
    logger: silentLogger(),
    now: () => NOW,
    administration: { db, administration: repo, accounts },
  });

  const request = (caller: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${caller}; ${CSRF_COOKIE}=c`, [CSRF_HEADER]: "c" },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  const audited = () => db.matching("insert into events").map((s) => s.params[3] as string);
  return { repo, db, accounts, request, audited };
}

describe("account administration", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("lists only this organization's accounts", async () => {
    const response = await h.request("admin", "GET", "/api/v1/users");
    expect(response.statusCode).toBe(200);
    const usernames = response.json().users.map((u: { username: string }) => u.username);
    expect(usernames).toContain("nurse");
    expect(usernames).not.toContain("foreign");
  });

  it("requires admin.users", async () => {
    expect((await h.request("nurse", "GET", "/api/v1/users")).statusCode).toBe(403);
  });

  it("creates an account with a one-time password that must be replaced, and audits it", async () => {
    const response = await h.request("admin", "POST", "/api/v1/users", {
      username: "ifeoma",
      displayName: "Ifeoma Nwosu",
      roleId: RECEPTION_ROLE,
      branchIds: [BRANCH],
    });
    expect(response.statusCode).toBe(201);
    const { user, temporaryPassword } = response.json();
    expect(temporaryPassword.length).toBeGreaterThan(15);
    expect(user.passwordChangeRequired).toBe(true);
    expect(h.audited()).toContain("admin.user_created");
    // The password reached the audit log nowhere.
    expect(JSON.stringify(h.db.statements)).not.toContain(temporaryPassword);
  });

  it("refuses another organization's role or branch", async () => {
    const role = await h.request("admin", "POST", "/api/v1/users", {
      username: "x1x", displayName: "X", roleId: FOREIGN_ROLE,
    });
    expect(role.statusCode).toBe(422);
    const branch = await h.request("admin", "POST", "/api/v1/users", {
      username: "x2x", displayName: "X", roleId: RECEPTION_ROLE, branchIds: [FOREIGN_BRANCH],
    });
    expect(branch.statusCode).toBe(422);
  });

  it("refuses a username already in use, whatever its case", async () => {
    const response = await h.request("admin", "POST", "/api/v1/users", {
      username: "NURSE", displayName: "Another", roleId: RECEPTION_ROLE,
    });
    expect(response.statusCode).toBe(409);
  });

  it("answers another organization's account as not found", async () => {
    expect((await h.request("admin", "PATCH", `/api/v1/users/${FOREIGN_USER}`, { enabled: false })).statusCode).toBe(404);
    expect((await h.request("admin", "POST", `/api/v1/users/${FOREIGN_USER}/reset-password`)).statusCode).toBe(404);
    expect(h.repo.users.get(FOREIGN_USER)!.enabled).toBe(true);
  });

  it("ends a disabled account's sessions at once, and audits it", async () => {
    const response = await h.request("admin", "PATCH", `/api/v1/users/${NURSE_ID}`, { enabled: false });
    expect(response.statusCode).toBe(200);
    expect(h.repo.sessions.get("f0000000-0000-4000-8000-000000000001")!.ended).toBe("terminated_by_admin");
    expect(h.audited()).toContain("admin.user_disabled");
  });

  it("will not let an administrator disable themselves", async () => {
    expect((await h.request("admin", "PATCH", `/api/v1/users/${ADMIN_ID}`, { enabled: false })).statusCode).toBe(409);
  });

  it("will not remove the last account able to manage users", async () => {
    const response = await h.request("admin", "PATCH", `/api/v1/users/${ADMIN_ID}`, { roleId: RECEPTION_ROLE });
    expect(response.statusCode).toBe(409);
    expect(h.repo.users.get(ADMIN_ID)!.roleId).toBe(ADMIN_ROLE);
  });

  it("records a role change as a security event", async () => {
    await h.request("admin", "PATCH", `/api/v1/users/${NURSE_ID}`, { roleId: ADMIN_ROLE });
    expect(h.audited()).toContain("auth.role_changed");
  });

  it("resets a password: new one-time password, lockout cleared, sessions ended", async () => {
    const response = await h.request("admin", "POST", `/api/v1/users/${NURSE_ID}/reset-password`);
    expect(response.statusCode).toBe(200);
    expect(response.json().temporaryPassword).toBeDefined();
    expect(h.repo.users.get(NURSE_ID)!.passwordChangeRequired).toBe(true);
    expect(h.repo.lockoutsCleared).toContain("nurse");
    expect(h.repo.sessions.get("f0000000-0000-4000-8000-000000000001")!.ended).toBe("password_changed");
    expect(h.audited()).toContain("admin.password_reset");
  });
});

describe("temporary passwords", () => {
  it("allow nothing but replacing themselves", async () => {
    const h = harness();
    const refused = await h.request("temporary", "GET", "/api/v1/users");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().reason).toBe("password_change_required");
  });

  it("are replaced only with the current password and a strong new one", async () => {
    const h = harness();
    const stored = await hashPassword(PASSWORD, FAST);
    h.accounts.accounts.push({
      account: { id: UserId(NURSE_ID), displayName: "N", username: "nurse", roleId: "r", branchIds: [], providerId: "local", enabled: true },
      hospitalId: HOSPITAL,
      roleKey: "r",
      permissions: [],
      passwordHash: stored.hash,
      passwordSalt: stored.salt,
    });

    const wrong = await h.request("temporary", "POST", "/api/v1/auth/password", {
      currentPassword: "not it",
      newPassword: "a much better passphrase",
    });
    expect(wrong.statusCode).toBe(403);

    const weak = await h.request("temporary", "POST", "/api/v1/auth/password", {
      currentPassword: PASSWORD,
      newPassword: "password",
    });
    expect(weak.statusCode).toBe(422);

    const changed = await h.request("temporary", "POST", "/api/v1/auth/password", {
      currentPassword: PASSWORD,
      newPassword: "a much better passphrase",
    });
    expect(changed.statusCode).toBe(200);
    expect(h.repo.users.get(NURSE_ID)!.passwordChangeRequired).toBe(false);
    expect(h.audited()).toContain("auth.password_changed");
  });
});

describe("session administration", () => {
  it("lists and ends only this organization's sessions", async () => {
    const h = harness();
    const list = await h.request("admin", "GET", "/api/v1/sessions");
    expect(list.json().sessions).toHaveLength(1);

    const foreign = await h.request("admin", "POST", "/api/v1/sessions/f0000000-0000-4000-8000-000000000009/revoke");
    expect(foreign.statusCode).toBe(404);
    expect(h.repo.sessions.get("f0000000-0000-4000-8000-000000000009")!.ended).toBeNull();

    const own = await h.request("admin", "POST", "/api/v1/sessions/f0000000-0000-4000-8000-000000000001/revoke");
    expect(own.statusCode).toBe(204);
    expect(h.audited()).toContain("auth.session_terminated");
  });
});

describe("branches", () => {
  it("creates a branch, refuses a duplicate code, and audits it", async () => {
    const h = harness();
    const created = await h.request("admin", "POST", "/api/v1/branches", { name: "Annex", code: "annex" });
    expect(created.statusCode).toBe(201);
    expect(h.audited()).toContain("config.branch_created");
    const duplicate = await h.request("admin", "POST", "/api/v1/branches", { name: "Annex 2", code: "ANNEX" });
    expect(duplicate.statusCode).toBe(409);
  });

  it("does not let one organization edit another's branch", async () => {
    const h = harness();
    const response = await h.request("admin", "PATCH", `/api/v1/branches/${FOREIGN_BRANCH}`, { name: "Mine now" });
    expect(response.statusCode).toBe(404);
    expect(h.repo.branches.get(FOREIGN_BRANCH)!.name).toBe("Elsewhere");
  });

  it("requires admin.settings to add a branch", async () => {
    const h = harness();
    expect((await h.request("nurse", "POST", "/api/v1/branches", { name: "X", code: "x" })).statusCode).toBe(403);
  });
});

describe("staff directory", () => {
  it("gives a reports.view holder names for ids and nothing more", async () => {
    const h = harness();
    // "nurse" lacks reports.view in this harness; the admin is given it below.
    expect((await h.request("nurse", "GET", "/api/v1/staff")).statusCode).toBe(403);

    const response = await h.request("admin", "GET", "/api/v1/staff");
    expect(response.statusCode).toBe(200);
    const staff = response.json().staff as Array<Record<string, unknown>>;
    expect(staff.map((s) => s["displayName"])).toContain("User 02");
    expect(staff.some((s) => s["displayName"] === "User 09")).toBe(false);
    expect(Object.keys(staff[0]!).sort()).toEqual(["displayName", "id"]);
  });
});
