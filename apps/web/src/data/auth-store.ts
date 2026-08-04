import {
  BranchId,
  DEFAULT_LOCKOUT_POLICY,
  DEFAULT_SESSION_POLICY,
  NO_LOCKOUT,
  UserId,
  describeDevice,
  endSession,
  isLocked,
  isUsable,
  recordFailure,
  touch,
  type AuthOutcome,
  type AuthenticatedUser,
  type IdentityProvider,
  type LockoutState,
  type Permission,
  type SecurityEventType,
  type Session,
  type SessionEndReason,
  type UserAccount,
} from "@qman/domain";
import { configStore, type ConfigStore } from "./config-store.js";

/**
 * Authentication and sessions.
 *
 * Holds providers, accounts and sessions, and resolves an authenticated user's
 * permissions from the role model that already exists — the domain remains the
 * authority on what a role may do, and this store only decides who someone is.
 *
 * Session state lives here rather than in a cookie because there is no server
 * yet. When persistence lands, sessions move to the database and this store
 * talks to it; the components above depend on `AuthenticatedUser` and do not
 * change.
 */

/** Where security events are recorded. */
export interface SecurityAuditSink {
  (input: {
    type: SecurityEventType;
    summary: string;
    actorId: UserId | null;
    correlationId: string | null;
  }): void;
}

export interface SignInResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly retryAfter?: Date;
}

export class AuthStore {
  #providers: IdentityProvider[] = [];
  #accounts: UserAccount[] = [];
  #sessions: Session[] = [];
  #lockouts = new Map<string, LockoutState>();
  #currentSessionId: string | null = null;
  #audit: SecurityAuditSink | null = null;
  #sequence = 0;
  #version = 0;
  #listeners = new Set<() => void>();

  constructor(private readonly config: ConfigStore = configStore) {}

  /**
   * Records sign-ins, lockouts and session terminations.
   *
   * A callback rather than a dependency on the operations store: authentication
   * must not know what an audit log is.
   */
  auditTo(sink: SecurityAuditSink): this {
    this.#audit = sink;
    return this;
  }

  #record(
    type: SecurityEventType,
    summary: string,
    actorId: UserId | null,
    correlationId: string | null,
  ): void {
    this.#audit?.({ type, summary, actorId, correlationId });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getVersion = (): number => this.#version;

  // ----------------------------------------------------------------- setup

  registerProvider(provider: IdentityProvider): void {
    this.#providers.push(provider);
    this.#commit();
  }

  addAccount(account: UserAccount): void {
    this.#accounts.push(account);
    this.#commit();
  }

  get providers(): readonly IdentityProvider[] {
    return this.#providers.filter((p) => p.enabled);
  }

  get accounts(): readonly UserAccount[] {
    return this.#accounts;
  }

  account(userId: UserId): UserAccount | undefined {
    return this.#accounts.find((a) => a.id === userId);
  }

  // ----------------------------------------------------------------- signin

  /**
   * Signs in through a named provider.
   *
   * Lockout is applied here rather than inside a provider, so it protects every
   * provider equally — including ones added later that have no idea it exists.
   */
  async signIn(
    providerId: string,
    credentials: { username: string; password: string },
    context: { userAgent: string; branchId?: BranchId } = { userAgent: "" },
    now: Date = new Date(),
  ): Promise<SignInResult> {
    const provider = this.#providers.find(
      (p) => p.id === providerId && p.enabled,
    );
    if (!provider?.authenticate) {
      return { ok: false, message: "That sign-in method is not available." };
    }

    const key = credentials.username.trim().toLowerCase();
    const lockout = this.#lockouts.get(key) ?? NO_LOCKOUT;

    if (isLocked(lockout, now)) {
      this.#record(
        "auth.account_locked",
        `Sign-in refused for "${credentials.username}" — account locked`,
        null,
        null,
      );
      // The one case where a specific message is right: a locked-out user
      // needs to know why, and the account plainly exists.
      return {
        ok: false,
        message: "Too many failed attempts. Try again shortly.",
        ...(lockout.lockedUntil ? { retryAfter: lockout.lockedUntil } : {}),
      };
    }

    const outcome: AuthOutcome = await provider.authenticate(credentials);

    if (!outcome.ok) {
      this.#lockouts.set(
        key,
        recordFailure(lockout, now, DEFAULT_LOCKOUT_POLICY),
      );
      this.#commit();
      // Recorded without naming an actor: a failed attempt has not proved who
      // it was, and attributing it would put a name against someone else's
      // mistyped password.
      this.#record(
        "auth.sign_in_failed",
        `Failed sign-in for "${credentials.username}"`,
        null,
        null,
      );
      return { ok: false, message: outcome.message };
    }

    this.#lockouts.delete(key);
    this.#startSession(outcome.account, context, now);
    this.#record(
      "auth.signed_in",
      `${outcome.account.displayName} signed in from ${describeDevice(context.userAgent)}`,
      outcome.account.id,
      this.#currentSessionId,
    );
    return { ok: true };
  }

  #startSession(
    account: UserAccount,
    context: { userAgent: string; branchId?: BranchId },
    now: Date,
  ): void {
    const session: Session = {
      id: `sess-${(this.#sequence += 1)}`,
      userId: account.id,
      branchId: context.branchId ?? account.branchIds[0] ?? null,
      providerId: account.providerId,
      startedAt: now,
      lastActiveAt: now,
      endedAt: null,
      endReason: null,
      device: describeDevice(context.userAgent),
      userAgent: context.userAgent,
    };

    this.#sessions.push(session);
    this.#currentSessionId = session.id;
    this.#commit();
  }

  signOut(now: Date = new Date()): void {
    const session = this.#session(this.#currentSessionId);
    if (session) {
      endSession(session, "signed_out", now);
      this.#record(
        "auth.signed_out",
        `${this.account(session.userId)?.displayName ?? "A user"} signed out`,
        session.userId,
        session.id,
      );
    }
    this.#currentSessionId = null;
    this.#commit();
  }

  // ---------------------------------------------------------------- current

  /**
   * The signed-in user, or null.
   *
   * Returns null for an expired session rather than silently extending it —
   * the timeout is the point.
   */
  currentUser(now: Date = new Date()): AuthenticatedUser | null {
    const session = this.#session(this.#currentSessionId);
    if (!session || !isUsable(session, now, DEFAULT_SESSION_POLICY)) {
      return null;
    }

    const account = this.account(session.userId);
    if (!account?.enabled) return null;

    return {
      account,
      permissions: this.permissionsFor(account),
      branchId: session.branchId,
    };
  }

  currentSession(): Session | null {
    return this.#session(this.#currentSessionId);
  }

  /** Records activity, extending the idle timeout. */
  touchCurrent(now: Date = new Date()): void {
    const session = this.#session(this.#currentSessionId);
    if (session) touch(session, now);
  }

  permissionsFor(account: UserAccount): readonly Permission[] {
    return this.config.roles.find((r) => r.id === account.roleId)?.permissions ?? [];
  }

  can(permission: Permission, now: Date = new Date()): boolean {
    return this.currentUser(now)?.permissions.includes(permission) ?? false;
  }

  // --------------------------------------------------------------- sessions

  /** Every session, newest first. Expired ones are included and labelled. */
  sessions(): readonly Session[] {
    return [...this.#sessions].sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
    );
  }

  activeSessions(now: Date = new Date()): Session[] {
    return this.sessions().filter((s) => isUsable(s, now, DEFAULT_SESSION_POLICY));
  }

  /**
   * Ends a session remotely.
   *
   * The reason this module is in Version 1: a reception workstation left signed
   * in overnight can be dealt with from anywhere, rather than by walking to the
   * machine.
   */
  terminateSession(
    sessionId: string,
    reason: SessionEndReason = "terminated_by_admin",
    now: Date = new Date(),
  ): void {
    const session = this.#session(sessionId);
    if (!session) return;
    endSession(session, reason, now);
    this.#record(
      "auth.session_terminated",
      `Session on ${session.device} for ${this.account(session.userId)?.displayName ?? "a user"} ended (${reason.replace(/_/g, " ")})`,
      session.userId,
      session.id,
    );
    if (sessionId === this.#currentSessionId) this.#currentSessionId = null;
    this.#commit();
  }

  /** Ends every session for a user — used when a password changes. */
  terminateAllFor(
    userId: UserId,
    reason: SessionEndReason = "password_changed",
    now: Date = new Date(),
  ): number {
    let ended = 0;
    for (const session of this.#sessions) {
      if (session.userId !== userId || session.endedAt !== null) continue;
      endSession(session, reason, now);
      if (session.id === this.#currentSessionId) this.#currentSessionId = null;
      ended += 1;
    }
    this.#commit();
    return ended;
  }

  #session(id: string | null): Session | null {
    if (!id) return null;
    return this.#sessions.find((s) => s.id === id) ?? null;
  }

  #commit(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}

export const authStore = new AuthStore();
