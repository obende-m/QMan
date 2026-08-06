/**
 * Platform authentication.
 *
 * The same shape as `AuthService` and deliberately not the same instance. A
 * platform administrator and a member of a hospital's staff are authenticated
 * by different services, against different tables, with different cookies, and
 * neither service can resolve the other's token.
 *
 * What is shared is implementation, not state: scrypt hashing from
 * `passwords.ts`, opaque tokens from `tokens.ts`, the lockout window and the
 * session lifetime policy from `@qman/domain`. There is one definition of how
 * long a session lives and one of what counts as too many failed attempts, and
 * both live in the domain where they can be tested without a database.
 *
 * What is not shared is any path from a platform credential to a hospital's
 * data. `resolve` returns a platform user and a platform session. It has no
 * hospital id to return, because a platform administrator is a member of no
 * hospital — which is the whole point of the separation and the reason this
 * file cannot accidentally grant organization access.
 */
import {
  DEFAULT_LOCKOUT_POLICY,
  DEFAULT_SESSION_POLICY,
  isLocked,
  isUsable,
  NO_LOCKOUT,
  permissionsForPlatformRole,
  recordFailure,
  type LockoutPolicy,
  type LockoutState,
  type PlatformPermission,
  type PlatformRole,
  type SessionPolicy,
} from "@qman/domain";
import type {
  PlatformSession,
  PlatformSessionRepository,
  PlatformUserRepository,
  StoredPlatformUser,
} from "@qman/persistence";
import { DUMMY_HASH, DUMMY_SALT } from "./auth.js";
import { hashPassword, needsRehash, verifyPassword } from "./passwords.js";
import { hashToken, issueToken } from "./tokens.js";

/**
 * Lockout state for platform accounts.
 *
 * Keyed by username alone — there is no hospital to scope it to. The port is
 * separate from the organization `LockoutStore` for the same reason the tables
 * are: a shared store keyed only by username would let a platform account and a
 * hospital account with the same name share a lock.
 */
export interface PlatformLockoutStore {
  get(usernameKey: string): Promise<LockoutState>;
  set(usernameKey: string, state: LockoutState): Promise<void>;
}

export interface PlatformAuthDependencies {
  readonly users: PlatformUserRepository;
  readonly sessions: PlatformSessionRepository;
  readonly lockouts: PlatformLockoutStore;
  readonly now: () => Date;
  readonly lockoutPolicy?: LockoutPolicy;
  readonly sessionPolicy?: SessionPolicy;
}

export interface PlatformCredentials {
  readonly username: string;
  readonly password: string;
  readonly userAgent: string;
}

export interface PlatformPrincipal {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: PlatformRole;
  readonly permissions: readonly PlatformPermission[];
}

export interface ResolvedPlatformSession {
  readonly user: PlatformPrincipal;
  readonly session: PlatformSession;
}

export type PlatformSignInFailure =
  | { readonly reason: "invalid_credentials"; readonly message: string }
  | {
      readonly reason: "account_locked";
      readonly message: string;
      readonly retryAfter: Date;
    };

export type PlatformSignInResult =
  | {
      readonly ok: true;
      readonly user: PlatformPrincipal;
      readonly session: PlatformSession;
      /** Returned exactly once. Only its hash is stored. */
      readonly token: string;
    }
  | { readonly ok: false; readonly failure: PlatformSignInFailure };

/**
 * One message for every way sign-in can fail on credentials.
 *
 * An unknown username and a wrong password must be indistinguishable, or the
 * form becomes an oracle for which platform accounts exist. There are few of
 * these accounts and each holds every platform permission, so the oracle would
 * be worth more here than anywhere else in the system.
 */
const INVALID = "That username and password do not match.";

function principal(user: StoredPlatformUser): PlatformPrincipal {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    permissions: permissionsForPlatformRole(user.role) ?? [],
  };
}

export class PlatformAuthService {
  readonly #deps: PlatformAuthDependencies;

  constructor(deps: PlatformAuthDependencies) {
    this.#deps = deps;
  }

  async signIn(credentials: PlatformCredentials): Promise<PlatformSignInResult> {
    const { users, sessions, lockouts, now } = this.#deps;
    const policy = this.#deps.lockoutPolicy ?? DEFAULT_LOCKOUT_POLICY;
    const at = now();
    const usernameKey = credentials.username.trim().toLowerCase();

    const lockout = await lockouts.get(usernameKey);
    if (isLocked(lockout, at)) {
      return {
        ok: false,
        failure: {
          reason: "account_locked",
          message: "This account is locked. Try again later.",
          retryAfter: lockout.lockedUntil!,
        },
      };
    }

    const stored = await users.findByUsername(usernameKey);

    /*
     * A password is verified even when the account does not exist.
     *
     * Returning early on an unknown username makes the response measurably
     * faster than one for a real account with a wrong password, and scrypt is
     * slow enough for that difference to be readable over a network. The work
     * is spent against a throwaway digest so the timing matches.
     */
    const matches = await verifyPassword(
      credentials.password,
      stored?.enabled === true ? stored.passwordHash : DUMMY_HASH,
      stored?.enabled === true ? stored.passwordSalt : DUMMY_SALT,
    );

    if (stored === null || !stored.enabled || !matches) {
      await lockouts.set(usernameKey, recordFailure(lockout, at, policy));
      return { ok: false, failure: { reason: "invalid_credentials", message: INVALID } };
    }

    // Sign-in is the only moment the plaintext exists, so it is the only moment
    // a digest created at an older cost can be brought up to the current one.
    if (needsRehash(stored.passwordHash)) {
      const rehashed = await hashPassword(credentials.password);
      await users.updatePassword(stored.id, rehashed.hash, rehashed.salt, at);
    }

    await lockouts.set(usernameKey, NO_LOCKOUT);

    const token = issueToken();
    const session = await sessions.create(
      {
        userId: stored.id,
        userAgent: credentials.userAgent,
        startedAt: at,
        lastActiveAt: at,
        endedAt: null,
        endReason: null,
      },
      hashToken(token),
    );

    return { ok: true, user: principal(stored), session, token };
  }

  /**
   * Resolves a presented token to the platform administrator holding it.
   *
   * The same whole check the organization side does: the session exists, has
   * not been ended, has not timed out, and its account is still enabled. A
   * session outliving the account it belongs to is how a departed administrator
   * keeps their access — and here that access is every organization QMan hosts.
   */
  async resolve(token: string): Promise<ResolvedPlatformSession | null> {
    const { users, sessions, now } = this.#deps;
    const policy = this.#deps.sessionPolicy ?? DEFAULT_SESSION_POLICY;
    const at = now();

    const session = await sessions.findByToken(hashToken(token));
    if (session === null) return null;

    if (!isUsable(session, at, policy)) {
      await sessions.end(session.id, "expired", at);
      return null;
    }

    const stored = await users.findById(session.userId);
    if (stored === null || !stored.enabled) {
      await sessions.end(session.id, "terminated_by_admin", at);
      return null;
    }

    await sessions.touch(session.id, at);
    return { user: principal(stored), session };
  }

  async signOut(token: string, reason = "signed_out"): Promise<void> {
    const session = await this.#deps.sessions.findByToken(hashToken(token));
    if (session === null) return;
    await this.#deps.sessions.end(session.id, reason, this.#deps.now());
  }
}
