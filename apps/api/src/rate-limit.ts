/**
 * Request rate limiting.
 *
 * A different control from account lockout, guarding a different attack, and
 * neither replaces the other.
 *
 * Lockout is keyed by username: it stops someone working through a password
 * list against one member of staff. It does nothing against the opposite shape
 * — one common password tried against a thousand usernames — because no single
 * account ever reaches its limit. That is what this stops, by capping attempts
 * from a source regardless of which account they name.
 *
 * Keyed by address, and that is why it cannot be the only control: an entire
 * clinic shares one address, so the limit has to be loose enough not to catch a
 * busy reception desk at shift change. Loose enough for that is far too loose
 * to protect a single account, which is the job lockout does.
 *
 * A sliding window rather than a fixed one. Fixed windows let an attacker send
 * a full allowance either side of a boundary and get double the rate at the
 * moment it matters least to be generous.
 */

export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMillis: number;
}

/**
 * Twenty attempts a minute from one address.
 *
 * A reception desk with several staff signing in after a shift change is a
 * handful of attempts; twenty is comfortably above that and far below what a
 * password-spraying script wants.
 */
export const DEFAULT_LOGIN_RATE_LIMIT: RateLimitPolicy = {
  limit: 20,
  windowMillis: 60_000,
};

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  /** When the caller may try again. Only meaningful once refused. */
  readonly retryAfter: Date;
}

export interface RateLimiter {
  check(key: string, now: Date): RateLimitResult;
}

/**
 * In memory, and adequate here in a way it is not for lockout.
 *
 * The window is a minute. A restart forgives at most a minute of history, which
 * is worth little to an attacker — where a forgiven lockout is worth a great
 * deal. Across several instances each holds its own count, so the effective
 * limit multiplies by the instance count; a deployment that grows past one
 * server should move this in front of the application, into the proxy that
 * already sees every request.
 */
export function createRateLimiter(
  policy: RateLimitPolicy = DEFAULT_LOGIN_RATE_LIMIT,
): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key: string, now: Date): RateLimitResult {
      const cutoff = now.getTime() - policy.windowMillis;
      const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);

      // Opportunistic cleanup: without it, every address ever seen is retained
      // for the lifetime of the process.
      if (hits.size > 10_000) {
        for (const [existing, times] of hits) {
          if (times.every((at) => at <= cutoff)) hits.delete(existing);
        }
      }

      if (recent.length >= policy.limit) {
        hits.set(key, recent);
        const oldest = recent[0] ?? now.getTime();
        return {
          allowed: false,
          remaining: 0,
          retryAfter: new Date(oldest + policy.windowMillis),
        };
      }

      recent.push(now.getTime());
      hits.set(key, recent);
      return {
        allowed: true,
        remaining: policy.limit - recent.length,
        retryAfter: now,
      };
    },
  };
}
