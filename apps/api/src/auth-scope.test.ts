/**
 * What a session is scoped to, and when it stops working.
 *
 * Driven against `AuthService` directly. The rules are about which branch a
 * session is pinned to and whether its organization is still active, and
 * neither needs HTTP to be tested honestly.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { BranchId, UserId, type Session } from "@qman/domain";
import type { SessionRepository, StoredAccount } from "@qman/persistence";
import { AuthService, createMemoryLockoutStore, type OrganizationLookup } from "./auth.js";
import { hashPassword } from "./passwords.js";
import { FAST, FakeAccounts, HOSPITAL, PASSWORD } from "./config-fixtures.js";

const OTHER_HOSPITAL = "99999999-9999-9999-9999-999999999999";
const MAIN = BranchId("22222222-2222-2222-2222-222222222222");
const ANNEX = BranchId("33333333-3333-3333-3333-333333333333");
const FOREIGN = BranchId("44444444-4444-4444-4444-000000000000");

class Sessions implements SessionRepository {
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

function organizations(status: { value: string }): OrganizationLookup {
  const branches = new Map<string, string>([
    [MAIN, HOSPITAL],
    [ANNEX, HOSPITAL],
    [FOREIGN, OTHER_HOSPITAL],
  ]);
  return {
    async findById(id) {
      return id === HOSPITAL ? { id, status: status.value } : { id, status: "active" };
    },
    async findByBranch(branchId) {
      const owner = branches.get(branchId);
      return owner === undefined ? null : { id: owner, status: "active" };
    },
  };
}

async function staff(branchIds: string[]): Promise<StoredAccount> {
  const stored = await hashPassword(PASSWORD, FAST);
  return {
    account: {
      id: UserId("aaaaaaaa-0000-4000-8000-000000000001"),
      displayName: "Ifeoma Nwosu",
      username: "ifeoma",
      roleId: "role-reception",
      branchIds: branchIds.map(BranchId),
      providerId: "local",
      enabled: true,
    },
    hospitalId: HOSPITAL,
    roleKey: "reception",
    permissions: ["queue.call"],
    passwordHash: stored.hash,
    passwordSalt: stored.salt,
  } as StoredAccount;
}

describe("session scope", () => {
  let accounts: FakeAccounts;
  let sessions: Sessions;
  let status: { value: string };
  let auth: AuthService;

  beforeEach(() => {
    accounts = new FakeAccounts();
    sessions = new Sessions();
    status = { value: "active" };
    let n = 0;
    auth = new AuthService({
      organizations: organizations(status),
      accounts,
      sessions,
      lockouts: createMemoryLockoutStore(),
      now: () => new Date("2026-03-09T09:00:00Z"),
      newId: () => `session-${(n += 1)}`,
    });
  });

  const signIn = (branchId: BranchId | null) =>
    auth.signIn({ hospitalId: HOSPITAL, username: "ifeoma", password: PASSWORD, userAgent: "", branchId });

  it("never widens a branch-restricted account to the whole organization", async () => {
    accounts.accounts.push(await staff([ANNEX]));
    const result = await signIn(null);
    expect(result.ok && result.session.branchId).toBe(ANNEX);
  });

  it("pins a restricted account to a branch it holds when it asks for one it does not", async () => {
    accounts.accounts.push(await staff([ANNEX]));
    const result = await signIn(MAIN);
    expect(result.ok && result.session.branchId).toBe(ANNEX);
  });

  it("honours a branch an organization-wide account chooses within its organization", async () => {
    accounts.accounts.push(await staff([]));
    const result = await signIn(MAIN);
    expect(result.ok && result.session.branchId).toBe(MAIN);
  });

  it("refuses to pin a session to another organization's branch", async () => {
    accounts.accounts.push(await staff([]));
    const result = await signIn(FOREIGN);
    expect(result.ok && result.session.branchId).toBeNull();
  });

  it("stops honouring an open session once the organization is suspended", async () => {
    accounts.accounts.push(await staff([]));
    const result = await signIn(null);
    if (!result.ok) throw new Error("sign-in failed");

    expect(await auth.resolve(result.token)).not.toBeNull();
    status.value = "suspended";
    expect(await auth.resolve(result.token)).toBeNull();
    // Not ended: a reactivated organization's staff carry on where they were.
    status.value = "active";
    expect(await auth.resolve(result.token)).not.toBeNull();
  });
});
