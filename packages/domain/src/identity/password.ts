/**
 * Password rules and lockout.
 *
 * Deliberately modest. Elaborate composition rules — forced rotation, symbol
 * quotas, character-class matrices — are well documented to make passwords
 * worse: people meet them with `Password1!` and write it on a sticky note
 * attached to the reception monitor. Length is the property that actually
 * matters, so that is what is enforced, with a short deny-list for the
 * passwords attackers try first.
 */

export interface PasswordPolicy {
  readonly minLength: number;
  /** Reject passwords found in a small list of obvious choices. */
  readonly blockCommonPasswords: boolean;
  /** Reject a password containing the username. */
  readonly blockUsername: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 10,
  blockCommonPasswords: true,
  blockUsername: true,
};

/**
 * The passwords guessed first. Not a substitute for server-side rate limiting,
 * but it stops the most common choices at the point they are set.
 */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyuiop",
  "letmein123",
  "welcome123",
  "admin12345",
  "hospital123",
  "changeme123",
  "qmanpassword",
]);

export interface PasswordCheck {
  readonly ok: boolean;
  readonly problems: readonly string[];
  /** 0-4, for a strength meter. Not a security guarantee. */
  readonly strength: number;
}

export function checkPassword(
  password: string,
  options: { username?: string; policy?: PasswordPolicy } = {},
): PasswordCheck {
  const policy = options.policy ?? DEFAULT_PASSWORD_POLICY;
  const problems: string[] = [];

  if (password.length < policy.minLength) {
    problems.push(
      `Use at least ${policy.minLength} characters. A short phrase works well.`,
    );
  }

  const lower = password.toLowerCase();

  if (policy.blockCommonPasswords && COMMON_PASSWORDS.has(lower)) {
    problems.push("That password is one of the first an attacker would try.");
  }

  if (
    policy.blockUsername &&
    options.username &&
    options.username.length >= 3 &&
    lower.includes(options.username.toLowerCase())
  ) {
    problems.push("Do not include your username in your password.");
  }

  /*
   * Strength is dominated by length, and variety contributes at most one
   * point in total.
   *
   * The obvious scoring — a point per character class — rates `Ab1!Ab1!Ab`
   * above a twenty-nine character passphrase, which is exactly backwards and
   * teaches users the wrong lesson. Three of the four available points come
   * from length.
   */
  let strength = 0;
  if (password.length >= policy.minLength) strength += 1;
  if (password.length >= 14) strength += 1;
  if (password.length >= 20) strength += 1;

  const mixedCase = /[a-z]/.test(password) && /[A-Z]/.test(password);
  const hasSymbolOrDigit = /\d/.test(password) || /[^\w\s]/.test(password);
  if (mixedCase || hasSymbolOrDigit) strength += 1;

  return {
    ok: problems.length === 0,
    problems,
    strength: problems.length === 0 ? Math.max(1, strength) : 0,
  };
}

// -------------------------------------------------------------------- lockout

export interface LockoutPolicy {
  readonly maxFailures: number;
  readonly lockDurationMillis: number;
  /** Failures older than this no longer count toward the limit. */
  readonly failureWindowMillis: number;
}

export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = {
  maxFailures: 5,
  lockDurationMillis: 15 * 60_000,
  failureWindowMillis: 15 * 60_000,
};

export interface LockoutState {
  readonly failures: readonly Date[];
  readonly lockedUntil: Date | null;
}

export const NO_LOCKOUT: LockoutState = { failures: [], lockedUntil: null };

export function isLocked(state: LockoutState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/**
 * Records a failed attempt, locking the account once the limit is reached
 * within the window.
 *
 * A rolling window rather than a running total: a receptionist who mistypes
 * twice on Monday and three times on Friday has not been attacked, and locking
 * them out is a support call for nothing.
 */
export function recordFailure(
  state: LockoutState,
  now: Date,
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
): LockoutState {
  const since = now.getTime() - policy.failureWindowMillis;
  const failures = [
    ...state.failures.filter((at) => at.getTime() >= since),
    now,
  ];

  if (failures.length >= policy.maxFailures) {
    return {
      failures: [],
      lockedUntil: new Date(now.getTime() + policy.lockDurationMillis),
    };
  }

  return { failures, lockedUntil: null };
}

/** A successful sign-in clears the slate. */
export function recordSuccess(): LockoutState {
  return NO_LOCKOUT;
}

/** Attempts left before locking, for a warning before it happens. */
export function attemptsRemaining(
  state: LockoutState,
  now: Date,
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
): number {
  if (isLocked(state, now)) return 0;
  const since = now.getTime() - policy.failureWindowMillis;
  const recent = state.failures.filter((at) => at.getTime() >= since).length;
  return Math.max(0, policy.maxFailures - recent);
}
