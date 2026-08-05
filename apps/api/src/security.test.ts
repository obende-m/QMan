/**
 * The controls that stand between a request and a handler.
 *
 * Each is tested for what it refuses, because that is the half that matters:
 * a control that accepts valid requests but has quietly stopped refusing
 * invalid ones looks perfectly healthy from the outside.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { UserId, type Session } from "@qman/domain";
import type { AccountRepository, SessionRepository, StoredAccount } from "@qman/persistence";
import { AuthService, createMemoryLockoutStore } from "./auth.js";
import { hashPassword } from "./passwords.js";
import { buildServer, CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "./server.js";
import { createLogger } from "./logging.js";
import { createRateLimiter } from "./rate-limit.js";

const ORIGIN = "https://qman.hospital.example";
const HOSPITAL = "11111111-1111-1111-1111-111111111111";
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

async function account(
  permissions: string[],
  overrides: Partial<StoredAccount> = {},
): Promise<StoredAccount> {
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
    permissions,
    passwordHash: stored.hash,
    passwordSalt: stored.salt,
    ...overrides,
  } as StoredAccount;
}

function harness(
  accounts: FakeAccounts,
  sessions: FakeSessions,
  overrides: { hospital?: string; lines?: string[] } = {},
) {
  let counter = 0;
  const auth = new AuthService({
    accounts,
    sessions,
    lockouts: createMemoryLockoutStore(),
    now: () => new Date("2026-03-09T09:00:00Z"),
    newId: () => `session-${(counter += 1)}`,
  });
  return buildServer({
    auth,
    resolveHospital: () => overrides.hospital ?? HOSPITAL,
    secureCookies: true,
    allowedOrigins: [ORIGIN],
    logger: createLogger({ write: (line) => overrides.lines?.push(line) }),
    now: () => new Date("2026-03-09T09:00:00Z"),
  });
}

function cookies(header: string | string[] | undefined): string {
  const values = Array.isArray(header) ? header : [header ?? ""];
  return values.map((v) => v.split(";")[0]).join("; ");
}

function csrfToken(header: string | string[] | undefined): string {
  const values = Array.isArray(header) ? header : [header ?? ""];
  const pair = values.find((v) => v.startsWith(CSRF_COOKIE))!.split(";")[0]!;
  return decodeURIComponent(pair.slice(CSRF_COOKIE.length + 1));
}

describe("authorization", () => {
  let accounts: FakeAccounts;
  let sessions: FakeSessions;

  beforeEach(() => {
    accounts = new FakeAccounts();
    sessions = new FakeSessions();
  });

  async function signIn(app: ReturnType<typeof harness>) {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });
    return {
      cookie: cookies(login.headers["set-cookie"]),
      csrf: csrfToken(login.headers["set-cookie"]),
    };
  }

  it("allows a route when the caller holds the permission it declares", async () => {
    accounts.accounts.push(await account(["admin.users"]));
    const app = harness(accounts, sessions);
    const { cookie } = await signIn(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  });

  /**
   * The rule that was previously enforced only by not drawing a button. A
   * hidden button is a request anyone can still make with a terminal.
   */
  it("refuses a route when the caller lacks the permission, though signed in", async () => {
    accounts.accounts.push(await account(["queue.call"]));
    const app = harness(accounts, sessions);
    const { cookie } = await signIn(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
    // Named, because the caller is staff who need to ask for the right thing.
    expect(response.json().permission).toBe("admin.users");
  });

  /**
   * 401 and 403 are different answers. 401 means "I do not know who you are"
   * and a client should offer a sign-in; 403 means re-authenticating would
   * change nothing.
   */
  it("answers 401 without a session and 403 with an insufficient one", async () => {
    accounts.accounts.push(await account(["queue.call"]));
    const app = harness(accounts, sessions);

    const anonymous = await app.inject({ method: "GET", url: "/api/v1/sessions" });
    expect(anonymous.statusCode).toBe(401);

    const { cookie } = await signIn(app);
    const signedIn = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { cookie },
    });
    expect(signedIn.statusCode).toBe(403);
  });

  /**
   * A valid session for one hospital must not reach another's data even with
   * the right permission. Worth an alarm rather than a quiet refusal.
   */
  it("refuses a session whose account belongs to a different hospital", async () => {
    accounts.accounts.push(await account(["admin.users"]));
    const lines: string[] = [];
    const app = harness(accounts, sessions);
    const { cookie } = await signIn(app);

    const elsewhere = harness(accounts, sessions, {
      hospital: "99999999-9999-9999-9999-999999999999",
      lines,
    });
    const response = await elsewhere.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(lines.join("")).toContain("cross-tenant request refused");
  });
});

describe("cross-site request forgery", () => {
  let accounts: FakeAccounts;
  let sessions: FakeSessions;

  beforeEach(async () => {
    accounts = new FakeAccounts();
    sessions = new FakeSessions();
    accounts.accounts.push(await account(["admin.users"]));
  });

  it("refuses an unsafe request from an origin it does not know", async () => {
    const app = harness(accounts, sessions);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "https://malicious.example" },
      payload: { username: "ifeoma", password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });

  /** On a browser an unsafe request always carries one; absence is not a browser. */
  it("refuses an unsafe request carrying no origin at all", async () => {
    const app = harness(accounts, sessions);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "ifeoma", password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });

  it("falls back to the referer when the origin is absent", async () => {
    const app = harness(accounts, sessions);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { referer: `${ORIGIN}/index.html` },
      payload: { username: "ifeoma", password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
  });

  /**
   * The double-submit pattern. A cross-site page can cause the session cookie
   * to be sent but cannot read the CSRF cookie, so it cannot produce the
   * header — which is exactly what the same-origin policy guarantees.
   */
  it("refuses an authenticated unsafe request with no CSRF header", async () => {
    const app = harness(accounts, sessions);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });
    const cookie = cookies(login.headers["set-cookie"]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie, origin: ORIGIN },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses an authenticated unsafe request whose CSRF header does not match", async () => {
    const app = harness(accounts, sessions);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });
    const cookie = cookies(login.headers["set-cookie"]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie, origin: ORIGIN, [CSRF_HEADER]: "a token from somewhere else" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("accepts an authenticated unsafe request carrying the matching token", async () => {
    const app = harness(accounts, sessions);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        cookie: cookies(login.headers["set-cookie"]),
        origin: ORIGIN,
        [CSRF_HEADER]: csrfToken(login.headers["set-cookie"]),
      },
    });
    expect(response.statusCode).toBe(204);
  });

  /** The application's own script must be able to read it to echo it back. */
  it("issues the CSRF cookie readable and the session cookie not", async () => {
    const app = harness(accounts, sessions);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });

    const set = login.headers["set-cookie"] as string[];
    const session = set.find((c) => c.startsWith(SESSION_COOKIE))!;
    const csrf = set.find((c) => c.startsWith(CSRF_COOKIE))!;

    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    expect(csrf).not.toContain("HttpOnly");
    expect(csrf).toContain("Secure");
  });

  it("does not require a token for a safe method", async () => {
    const app = harness(accounts, sessions);
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
  });

  /** A token surviving into the next person's session on a shared workstation. */
  it("issues a different CSRF token for each session", async () => {
    const app = harness(accounts, sessions);
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });

    expect(csrfToken(first.headers["set-cookie"])).not.toBe(
      csrfToken(second.headers["set-cookie"]),
    );
  });
});

describe("login rate limiting", () => {
  /**
   * Guards the attack lockout cannot see: one password against many usernames,
   * where no single account ever reaches its own limit.
   */
  it("caps attempts from one source regardless of which account they name", () => {
    const limiter = createRateLimiter({ limit: 3, windowMillis: 60_000 });
    const at = new Date("2026-03-09T09:00:00Z");

    expect(limiter.check("10.0.0.1", at).allowed).toBe(true);
    expect(limiter.check("10.0.0.1", at).allowed).toBe(true);
    expect(limiter.check("10.0.0.1", at).allowed).toBe(true);
    expect(limiter.check("10.0.0.1", at).allowed).toBe(false);
  });

  it("counts each source separately", () => {
    const limiter = createRateLimiter({ limit: 1, windowMillis: 60_000 });
    const at = new Date("2026-03-09T09:00:00Z");

    expect(limiter.check("10.0.0.1", at).allowed).toBe(true);
    expect(limiter.check("10.0.0.1", at).allowed).toBe(false);
    expect(limiter.check("10.0.0.2", at).allowed).toBe(true);
  });

  /** Sliding, not fixed: a boundary must not hand out a double allowance. */
  it("forgives attempts once they leave the window", () => {
    const limiter = createRateLimiter({ limit: 2, windowMillis: 60_000 });
    const start = new Date("2026-03-09T09:00:00Z");

    limiter.check("10.0.0.1", start);
    limiter.check("10.0.0.1", start);
    expect(limiter.check("10.0.0.1", new Date(start.getTime() + 30_000)).allowed).toBe(false);
    expect(limiter.check("10.0.0.1", new Date(start.getTime() + 61_000)).allowed).toBe(true);
  });

  it("says when the caller may try again", () => {
    const limiter = createRateLimiter({ limit: 1, windowMillis: 60_000 });
    const at = new Date("2026-03-09T09:00:00Z");
    limiter.check("10.0.0.1", at);

    const refused = limiter.check("10.0.0.1", at);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter.getTime()).toBe(at.getTime() + 60_000);
  });

  it("refuses sign-in over HTTP once the limit is reached, before checking the password", async () => {
    const accounts = new FakeAccounts();
    const sessions = new FakeSessions();
    accounts.accounts.push(await account(["queue.call"]));

    const auth = new AuthService({
      accounts,
      sessions,
      lockouts: createMemoryLockoutStore(),
      now: () => new Date("2026-03-09T09:00:00Z"),
      newId: () => "session-1",
    });
    const app = buildServer({
      auth,
      resolveHospital: () => HOSPITAL,
      secureCookies: true,
      allowedOrigins: [ORIGIN],
      rateLimiter: createRateLimiter({ limit: 2, windowMillis: 60_000 }),
      now: () => new Date("2026-03-09T09:00:00Z"),
    });

    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: ORIGIN },
        payload: { username: "ifeoma", password: PASSWORD },
      });

    expect((await attempt()).statusCode).toBe(200);
    expect((await attempt()).statusCode).toBe(200);

    const refused = await attempt();
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBeDefined();
  });
});
