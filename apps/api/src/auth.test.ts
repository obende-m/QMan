/**
 * Authentication rules, end to end over the HTTP surface.
 *
 * Driven through `inject` rather than a socket, so these are ordinary unit
 * tests: fast enough to run on every change, which is the only way security
 * rules stay covered rather than becoming a manual pass before a release.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { BranchId, UserId, type Session } from "@qman/domain";
import type { AccountRepository, SessionRepository, StoredAccount } from "@qman/persistence";
import { AuthService, createMemoryLockoutStore } from "./auth.js";
import { hashPassword } from "./passwords.js";
import { hashToken } from "./tokens.js";
import { buildServer, CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "./server.js";
import { createLogger } from "./logging.js";

const ORIGIN = "https://qman.hospital.example";
const HOSPITAL = "11111111-1111-1111-1111-111111111111";
const OTHER_HOSPITAL = "22222222-2222-2222-2222-222222222222";
const PASSWORD = "a reasonable passphrase";
const FAST = { N: 1024, r: 8, p: 1, keyLength: 64 };

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

  async updatePassword(userId: string, hash: string, salt: string): Promise<void> {
    const index = this.accounts.findIndex((a) => a.account.id === userId);
    const existing = this.accounts[index];
    if (existing === undefined) return;
    this.accounts[index] = { ...existing, passwordHash: hash, passwordSalt: salt };
  }
}

class FakeSessions implements SessionRepository {
  readonly rows = new Map<string, { session: Session; tokenHash: string }>();

  async find(id: string): Promise<Session | null> {
    return this.rows.get(id)?.session ?? null;
  }

  async findByToken(tokenHash: string): Promise<Session | null> {
    for (const row of this.rows.values()) {
      // Ended sessions are excluded here exactly as the SQL excludes them.
      if (row.tokenHash === tokenHash && row.session.endedAt === null) return row.session;
    }
    return null;
  }

  async create(session: Session, tokenHash: string): Promise<void> {
    this.rows.set(session.id, { session, tokenHash });
  }

  async activeForHospital(): Promise<Session[]> {
    return [...this.rows.values()].map((r) => r.session).filter((s) => s.endedAt === null);
  }

  async save(session: Session): Promise<void> {
    const existing = this.rows.get(session.id);
    if (existing) this.rows.set(session.id, { ...existing, session });
  }

  async endAllForUser(userId: string, reason: string, at: Date): Promise<number> {
    let ended = 0;
    for (const row of this.rows.values()) {
      if (row.session.userId === userId && row.session.endedAt === null) {
        row.session.endedAt = at;
        row.session.endReason = reason as Session["endReason"];
        ended += 1;
      }
    }
    return ended;
  }
}

async function account(overrides: Partial<StoredAccount> = {}): Promise<StoredAccount> {
  const stored = await hashPassword(PASSWORD, FAST);
  return {
    account: {
      id: UserId("aaaaaaaa-0000-0000-0000-000000000001"),
      displayName: "Ifeoma Nwosu",
      username: "ifeoma",
      roleId: "role-reception",
      branchIds: [],
      providerId: "local",
      enabled: true,
    },
    hospitalId: HOSPITAL,
    roleKey: "reception",
    permissions: ["visit.create", "queue.call"],
    passwordHash: stored.hash,
    passwordSalt: stored.salt,
    ...overrides,
  } as StoredAccount;
}

function harness(accounts: FakeAccounts, sessions: FakeSessions, lines: string[] = []) {
  let counter = 0;
  const auth = new AuthService({
    accounts,
    sessions,
    lockouts: createMemoryLockoutStore(),
    now: () => new Date("2026-03-09T09:00:00Z"),
    newId: () => `session-${(counter += 1)}`,
  });
  const app = buildServer({
    auth,
    resolveHospital: () => HOSPITAL,
    secureCookies: true,
    allowedOrigins: [ORIGIN],
    logger: createLogger({ write: (line) => lines.push(line) }),
    now: () => new Date("2026-03-09T09:00:00Z"),
  });
  return { app, auth };
}

/** The session cookie alone, as `name=value`. */
function cookieFrom(header: string | string[] | undefined): string {
  const values = Array.isArray(header) ? header : [header ?? ""];
  return values.find((v) => v.startsWith(SESSION_COOKIE))!.split(";")[0]!;
}

/** Every cookie the response set, as a browser would send them back. */
function allCookies(header: string | string[] | undefined): string {
  const values = Array.isArray(header) ? header : [header ?? ""];
  return values.map((v) => v.split(";")[0]).join("; ");
}

function csrfFrom(header: string | string[] | undefined): string {
  const values = Array.isArray(header) ? header : [header ?? ""];
  const pair = values.find((v) => v.startsWith(CSRF_COOKIE))!.split(";")[0]!;
  return decodeURIComponent(pair.slice(CSRF_COOKIE.length + 1));
}

describe("sign-in", () => {
  let accounts: FakeAccounts;
  let sessions: FakeSessions;

  beforeEach(async () => {
    accounts = new FakeAccounts();
    sessions = new FakeSessions();
    accounts.accounts.push(await account());
  });

  it("signs a user in and returns their permissions", async () => {
    const { app } = harness(accounts, sessions);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.displayName).toBe("Ifeoma Nwosu");
    expect(response.json().user.permissions).toContain("queue.call");
  });

  /**
   * The whole point of moving authentication off the browser. A response that
   * carried the digest would have moved the problem, not solved it.
   */
  it("never returns the password digest or the salt", async () => {
    const { app } = harness(accounts, sessions);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });

    expect(response.body).not.toContain("scrypt");
    expect(response.body).not.toContain(accounts.accounts[0]!.passwordSalt!);
    expect(response.body).not.toContain(PASSWORD);
  });

  it("issues an HttpOnly, Secure, SameSite cookie", async () => {
    const { app } = harness(accounts, sessions);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });

    const header = response.headers["set-cookie"];
    const cookie = Array.isArray(header) ? header[0]! : header!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  /** A stored token is a working login for anyone holding a database copy. */
  it("stores only the hash of the token", async () => {
    const { app } = harness(accounts, sessions);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });

    const token = decodeURIComponent(cookieFrom(response.headers["set-cookie"]).split("=")[1]!);
    const [row] = [...sessions.rows.values()];
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(row!.tokenHash).not.toBe(token);
    expect(JSON.stringify([...sessions.rows.values()])).not.toContain(token);
  });

  it("gives the same answer for a wrong password and a username that does not exist", async () => {
    const { app } = harness(accounts, sessions);
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: "not the password" },
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "nobody", password: "not the password" },
    });

    expect(wrong.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error).toBe(wrong.json().error);
  });

  /**
   * Tenancy is enforced in the lookup, not in the UI. An account in another
   * hospital must be invisible even with the correct password.
   */
  it("will not authenticate an account belonging to another hospital", async () => {
    accounts.accounts.push(
      await account({
        hospitalId: OTHER_HOSPITAL,
        account: {
          id: UserId("bbbbbbbb-0000-0000-0000-000000000002"),
          displayName: "Someone Else",
          username: "adams",
          roleId: "role-clinician",
          branchIds: [],
          providerId: "local",
          enabled: true,
        },
      }),
    );

    const { app } = harness(accounts, sessions);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "adams", password: PASSWORD },
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a disabled account", async () => {
    accounts.accounts[0] = await account({
      account: { ...accounts.accounts[0]!.account, enabled: false },
    });

    const { app } = harness(accounts, sessions);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().reason).toBe("account_disabled");
  });

  it("locks an account after repeated failures and says so", async () => {
    const { app } = harness(accounts, sessions);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: ORIGIN },
        payload: { username: "ifeoma", password: "wrong" },
      });
    }

    // Correct password, still refused — the lock is on the account, not the guess.
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().reason).toBe("account_locked");
    expect(response.json().retryAfter).toBeDefined();
  });

  it("matches usernames case-insensitively", async () => {
    const { app } = harness(accounts, sessions);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "IFEOMA", password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects an empty username or password without touching the store", async () => {
    const { app } = harness(accounts, sessions);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "", password: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(sessions.rows.size).toBe(0);
  });

  it("upgrades a digest created at an older cost, without changing the password", async () => {
    const weak = await hashPassword(PASSWORD, { N: 512, r: 8, p: 1, keyLength: 64 });
    accounts.accounts[0] = await account({
      passwordHash: weak.hash,
      passwordSalt: weak.salt,
    });

    const { app } = harness(accounts, sessions);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(accounts.accounts[0]!.passwordHash).not.toBe(weak.hash);
    expect(accounts.accounts[0]!.passwordHash!.startsWith("scrypt$16384$")).toBe(true);
  });
});

describe("session resolution", () => {
  let accounts: FakeAccounts;
  let sessions: FakeSessions;

  beforeEach(async () => {
    accounts = new FakeAccounts();
    sessions = new FakeSessions();
    accounts.accounts.push(await account());
  });

  async function signedIn() {
    const lines: string[] = [];
    const { app } = harness(accounts, sessions, lines);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });
    return {
      app,
      cookie: allCookies(login.headers["set-cookie"]),
      csrf: csrfFrom(login.headers["set-cookie"]),
      lines,
    };
  }

  it("identifies the holder of a session cookie", async () => {
    const { app, cookie } = await signedIn();
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.username).toBe("ifeoma");
  });

  it("refuses a request with no cookie", async () => {
    const { app } = await signedIn();
    const response = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a token that was never issued", async () => {
    const { app } = await signedIn();
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `${SESSION_COOKIE}=not-a-real-token` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("stops honouring a session after sign-out", async () => {
    const { app, cookie, csrf } = await signedIn();

    const out = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, origin: ORIGIN, [CSRF_HEADER]: csrf },
    });
    expect(out.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("answers sign-out identically whether or not the session existed", async () => {
    const { app } = await signedIn();
    // A well-formed request in every respect except that its session is not
    // one this server issued. It must not be told that.
    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie: `${SESSION_COOKIE}=never-issued; ${CSRF_COOKIE}=matching`,
        origin: ORIGIN,
        [CSRF_HEADER]: "matching",
      },
    });
    expect(unknown.statusCode).toBe(204);
  });

  /** A session outliving the account is how a dismissed employee keeps working. */
  it("stops honouring a session once the account is disabled", async () => {
    const { app, cookie } = await signedIn();
    accounts.accounts[0] = await account({
      account: { ...accounts.accounts[0]!.account, enabled: false },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(401);
  });

  it("ends every session for a user when access is withdrawn", async () => {
    const { app, cookie } = await signedIn();
    const { auth } = harness(accounts, sessions);

    const ended = await auth.signOutEverywhere(
      UserId("aaaaaaaa-0000-0000-0000-000000000001"),
      "terminated_by_admin",
    );

    expect(ended).toBe(1);
    const after = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });
});

describe("request identity and logging", () => {
  it("adopts a request id from a proxy, and mints one otherwise", async () => {
    const lines: string[] = [];
    const { app } = harness(new FakeAccounts(), new FakeSessions(), lines);

    await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { "x-request-id": "from-the-proxy" },
    });
    await app.inject({ method: "GET", url: "/api/health" });

    const logged = lines.map((line) => JSON.parse(line) as { requestId: string });
    expect(logged[0]!.requestId).toBe("from-the-proxy");
    expect(logged[1]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs the questions an incident actually asks", async () => {
    const accounts = new FakeAccounts();
    const sessions = new FakeSessions();
    accounts.accounts.push(await account());
    const lines: string[] = [];
    const { app } = harness(accounts, sessions, lines);

    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });

    const entry = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line["message"] === "request")!;

    expect(entry["at"]).toBeDefined();
    expect(entry["hospitalId"]).toBe(HOSPITAL);
    expect(entry["requestId"]).toBeDefined();
    expect(entry["status"]).toBe(200);
    expect(entry["path"]).toBe("/api/auth/login");
  });

  it("never writes a password or a token to the log", async () => {
    const accounts = new FakeAccounts();
    const sessions = new FakeSessions();
    accounts.accounts.push(await account());
    const lines: string[] = [];
    const { app } = harness(accounts, sessions, lines);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: "wrong one" },
    });

    const token = decodeURIComponent(cookieFrom(login.headers["set-cookie"]).split("=")[1]!);
    const everything = lines.join("\n");
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain("wrong one");
    expect(everything).not.toContain(token);
  });
});
