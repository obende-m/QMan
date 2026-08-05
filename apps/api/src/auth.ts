/**
 * Authentication.
 *
 * The local password provider, moved to where it always belonged. Verifying a
 * password in a browser meant shipping the comparison and the stored digest to
 * the machine trying to get in; the browser now sends credentials and is told
 * only whether it worked.
 *
 * This layer knows nothing about HTTP. It takes credentials and returns an
 * outcome, so the rules below — uniform failure messages, lockout, session
 * issuance — are testable without a server, a socket or a cookie.
 */
import {
  DEFAULT_LOCKOUT_POLICY,
  DEFAULT_SESSION_POLICY,
  GENERIC_AUTH_FAILURE,
  NO_LOCKOUT,
  describeDevice,
  endSession,
  invalidCredentials,
  isLocked,
  isUsable,
  recordFailure,
  touch,
  type AuthOutcome,
  type AuthenticatedUser,
  type BranchId,
  type LockoutPolicy,
  type LockoutState,
  type Session,
  type SessionEndReason,
  type SessionPolicy,
  type UserId,
} from "@qman/domain";
import type { AccountRepository, SessionRepository, StoredAccount } from "@qman/persistence";
import { hashPassword, needsRehash, verifyPassword } from "./passwords.js";
import { hashToken, issueToken } from "./tokens.js";

/**
 * Where lockout counters live.
 *
 * A port, because the process-local implementation below is not the final
 * answer. Counters held in memory are lost on restart and are not shared
 * between instances, which weakens lockout to "per process, until the next
 * deploy". For a single hospital server that is a reasonable V1 and an honest
 * limitation; for more than one instance it must become a table.
 */
export interface LockoutStore {
  get(key: string): LockoutState;
  set(key: string, state: LockoutState): void;
}

export function createMemoryLockoutStore(): LockoutStore {
  const states = new Map<string, LockoutState>();
  return {
    get: (key) => states.get(key) ?? NO_LOCKOUT,
    set: (key, state) => {
      states.set(key, state);
    },
  };
}

export interface AuthDependencies {
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  readonly lockouts: LockoutStore;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly lockoutPolicy?: LockoutPolicy;
  readonly sessionPolicy?: SessionPolicy;
}

export interface Credentials {
  readonly hospitalId: string;
  readonly username: string;
  readonly password: string;
  readonly userAgent: string;
  readonly branchId: BranchId | null;
}

export type SignInResult =
  | {
      readonly ok: true;
      readonly user: AuthenticatedUser;
      readonly session: Session;
      /** Returned exactly once. Only its hash is stored. */
      readonly token: string;
    }
  | { readonly ok: false; readonly failure: Extract<AuthOutcome, { ok: false }> };

function authenticatedUser(
  stored: StoredAccount,
  branchId: BranchId | null,
): AuthenticatedUser {
  return { account: stored.account, permissions: stored.permissions, branchId };
}

/**
 * Lockout is keyed by hospital and username, not by IP.
 *
 * An IP is shared by an entire clinic behind one router, so locking on it locks
 * the whole reception desk out because one person mistyped. Rate limiting by
 * address belongs in front of this, and does a different job.
 */
function lockoutKey(hospitalId: string, username: string): string {
  return `${hospitalId}:${username.toLowerCase()}`;
}

export class AuthService {
  readonly #deps: AuthDependencies;

  constructor(deps: AuthDependencies) {
    this.#deps = deps;
  }

  async signIn(credentials: Credentials): Promise<SignInResult> {
    const { accounts, sessions, lockouts, now, newId } = this.#deps;
    const policy = this.#deps.lockoutPolicy ?? DEFAULT_LOCKOUT_POLICY;
    const at = now();
    const key = lockoutKey(credentials.hospitalId, credentials.username);

    const lockout = lockouts.get(key);
    if (isLocked(lockout, at)) {
      // The one case that does not use the uniform message: someone genuinely
      // locked out needs to know why, and that the wait is finite.
      return {
        ok: false,
        failure: {
          ok: false,
          reason: "account_locked",
          message:
            "Too many failed attempts. This account is locked temporarily — try again shortly, or ask an administrator.",
          retryAfter: lockout.lockedUntil ?? at,
        },
      };
    }

    const stored = await accounts.findByUsername(
      credentials.hospitalId,
      credentials.username,
    );

    /**
     * The password is verified even when no such account exists, against a
     * digest that cannot match. Returning early would make a missing username
     * measurably faster than a wrong password and turn this endpoint into a
     * list of who works here.
     */
    const matched = await verifyPassword(
      credentials.password,
      stored?.passwordHash ?? DUMMY_HASH,
      stored?.passwordSalt ?? DUMMY_SALT,
    );

    if (stored === null || !matched) {
      lockouts.set(key, recordFailure(lockout, at, policy));
      return { ok: false, failure: invalidCredentials() as Extract<AuthOutcome, { ok: false }> };
    }

    if (!stored.account.enabled) {
      // Disabled accounts are told apart from wrong passwords deliberately: the
      // person is staff, they are at the desk, and "your access was withdrawn"
      // is a conversation with an administrator rather than a retry.
      return {
        ok: false,
        failure: {
          ok: false,
          reason: "account_disabled",
          message: "This account has been disabled. Contact an administrator.",
        },
      };
    }

    lockouts.set(key, NO_LOCKOUT);

    // The only moment the plaintext is in hand, and so the only moment a
    // digest created at an older cost can be brought up to the current one.
    if (needsRehash(stored.passwordHash)) {
      await this.#rehash(stored, credentials.password);
    }

    const branchId = this.#resolveBranch(stored, credentials.branchId);
    const session: Session = {
      id: newId(),
      userId: stored.account.id,
      branchId,
      providerId: stored.account.providerId,
      startedAt: at,
      lastActiveAt: at,
      endedAt: null,
      endReason: null,
      device: describeDevice(credentials.userAgent),
      userAgent: credentials.userAgent,
    };

    const token = issueToken();
    await sessions.create(session, hashToken(token));

    return { ok: true, user: authenticatedUser(stored, branchId), session, token };
  }

  /**
   * Resolves a presented token to the user holding it.
   *
   * Every authenticated request runs this, so it does the whole check in one
   * place: the session exists, has not been ended, has not timed out, and its
   * account is still enabled. A session outliving the account it belongs to is
   * how a dismissed employee keeps working.
   */
  async resolve(token: string): Promise<{ user: AuthenticatedUser; session: Session } | null> {
    const { accounts, sessions, now } = this.#deps;
    const policy = this.#deps.sessionPolicy ?? DEFAULT_SESSION_POLICY;
    const at = now();

    const session = await sessions.findByToken(hashToken(token));
    if (session === null) return null;

    if (!isUsable(session, at, policy)) {
      endSession(session, "expired", at);
      await sessions.save(session);
      return null;
    }

    const stored = await accounts.findById(session.userId);
    if (stored === null || !stored.account.enabled) {
      endSession(session, "terminated_by_admin", at);
      await sessions.save(session);
      return null;
    }

    touch(session, at);
    await sessions.save(session);

    return { user: authenticatedUser(stored, session.branchId), session };
  }

  async signOut(token: string, reason: SessionEndReason = "signed_out"): Promise<void> {
    const { sessions, now } = this.#deps;
    const session = await sessions.findByToken(hashToken(token));
    if (session === null) return;
    endSession(session, reason, now());
    await sessions.save(session);
  }

  /** Ends every session for a user. Used when a password changes or access is withdrawn. */
  async signOutEverywhere(userId: UserId, reason: SessionEndReason): Promise<number> {
    return this.#deps.sessions.endAllForUser(userId, reason, this.#deps.now());
  }

  async #rehash(stored: StoredAccount, password: string): Promise<void> {
    const fresh = await hashPassword(password);
    await this.#deps.accounts.updatePassword(
      stored.account.id,
      fresh.hash,
      fresh.salt,
      this.#deps.now(),
    );
  }

  /**
   * An empty grant means every branch, which is how a single-site hospital
   * avoids configuring something it does not have. A request for a branch the
   * user does not hold falls back to no branch rather than being honoured.
   */
  #resolveBranch(stored: StoredAccount, requested: BranchId | null): BranchId | null {
    if (requested === null) return null;
    const granted = stored.account.branchIds;
    if (granted.length === 0 || granted.includes(requested)) return requested;
    return null;
  }
}

export { GENERIC_AUTH_FAILURE };

/**
 * A real digest of a value nobody knows, used only to spend the same time on a
 * missing account as on a wrong password. Never matches: the salt is fixed and
 * the plaintext behind it was discarded.
 */
const DUMMY_HASH =
  "scrypt$16384$8$1$" +
  "0e1cbb62c1c05ac2b0b4fb7b57f9fa4dfe6da3ba39f10b6b0a3e2a08d1c8e3f2" +
  "5b41f2f37a0b7f1f1f0a5e8c3d2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09";
const DUMMY_SALT = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
