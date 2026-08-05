/**
 * The configuration read.
 *
 * The properties under test are about who may read it and what comes back —
 * not about what a valid configuration is, which is the domain's question and
 * is tested there.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { UserId, type HospitalConfiguration, type RoleConfig, type Session } from "@qman/domain";
import type {
  AccountRepository,
  ConfigurationRepository,
  SessionRepository,
  StoredAccount,
} from "@qman/persistence";
import { AuthService, createMemoryLockoutStore } from "./auth.js";
import { hashPassword } from "./passwords.js";
import { buildServer } from "./server.js";
import { silentLogger } from "./logging.js";

const ORIGIN = "https://qman.hospital.example";
const HOSPITAL = "11111111-1111-1111-1111-111111111111";
const PASSWORD = "a reasonable passphrase";
const FAST = { N: 1024, r: 8, p: 1, keyLength: 64 };

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
    branches: [],
    stations: [],
    workflows: [],
    displayBoards: [],
    ticketTemplates: [],
    defaults: { namePolicy: "ticket_only", ticketTemplateId: "t1" },
  } as unknown as HospitalConfiguration;
}

class FakeConfiguration implements ConfigurationRepository {
  value: HospitalConfiguration | null = configuration();
  roles: RoleConfig[] = [
    { id: "r1", name: "Reception", description: "", permissions: ["queue.call"], isSystem: true },
  ];

  async load(): Promise<HospitalConfiguration | null> {
    return this.value;
  }

  async loadRoles(): Promise<RoleConfig[]> {
    return this.roles;
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
      displayName: "Ifeoma Nwosu",
      username: "ifeoma",
      roleId: "r1",
      branchIds: [],
      providerId: "local",
      enabled: true,
    },
    hospitalId: HOSPITAL,
    roleKey: "reception",
    permissions,
    passwordHash: stored.hash,
    passwordSalt: stored.salt,
  } as StoredAccount;
}

describe("configuration endpoint", () => {
  let accounts: FakeAccounts;
  let sessions: FakeSessions;
  let config: FakeConfiguration;

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
      configuration: { configuration: config },
    });
  }

  async function signIn(app: ReturnType<typeof server>) {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "ifeoma", password: PASSWORD },
    });
    const set = login.headers["set-cookie"] as string[];
    return set.map((c) => c.split(";")[0]).join("; ");
  }

  beforeEach(() => {
    accounts = new FakeAccounts();
    sessions = new FakeSessions();
    config = new FakeConfiguration();
  });

  /**
   * A receptionist cannot work without knowing the stations. Gating this behind
   * an administration permission would force every screen to keep its own copy,
   * which is the duplication the endpoint exists to remove.
   */
  it("serves the configuration to any signed-in member of staff", async () => {
    accounts.accounts.push(await account(["queue.call"]));
    const app = server();
    const cookie = await signIn(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/config", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().configuration.profile.name).toBe("Ikeja General Hospital");
  });

  it("refuses a caller with no session", async () => {
    accounts.accounts.push(await account(["queue.call"]));
    const response = await server().inject({ method: "GET", url: "/api/v1/config" });
    expect(response.statusCode).toBe(401);
  });

  /**
   * Returned with the configuration rather than from a second endpoint, so a
   * surface cannot render one without having been told what is wrong with it.
   */
  it("returns the domain's problems alongside the configuration", async () => {
    accounts.accounts.push(await account(["queue.call"]));
    const app = server();
    const cookie = await signIn(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/config", headers: { cookie } });
    expect(Array.isArray(response.json().problems)).toBe(true);
  });

  /**
   * A server pointed at a hospital that does not exist is a deployment fault,
   * not a request fault, and must not look like an empty hospital.
   */
  it("fails loudly when the configured hospital does not exist", async () => {
    accounts.accounts.push(await account(["queue.call"]));
    config.value = null;
    const app = server();
    const cookie = await signIn(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/config", headers: { cookie } });
    expect(response.statusCode).toBe(500);
    expect(response.json().requestId).toBeDefined();
  });

  describe("roles", () => {
    it("requires the permission to manage users", async () => {
      accounts.accounts.push(await account(["queue.call"]));
      const app = server();
      const cookie = await signIn(app);

      const response = await app.inject({ method: "GET", url: "/api/v1/roles", headers: { cookie } });
      expect(response.statusCode).toBe(403);
      expect(response.json().permission).toBe("admin.users");
    });

    it("serves them to an administrator", async () => {
      accounts.accounts.push(await account(["admin.users"]));
      const app = server();
      const cookie = await signIn(app);

      const response = await app.inject({ method: "GET", url: "/api/v1/roles", headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json().roles[0].name).toBe("Reception");
    });
  });
});
