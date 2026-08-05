/**
 * Session tokens.
 *
 * Hashed with SHA-256, and that is a deliberate departure from how passwords
 * are treated a file away. The reason is entropy, not carelessness.
 *
 * A password is chosen by a person and is guessable — perhaps thirty bits of
 * real entropy on a good day — so verifying one must be made expensive enough
 * that guessing at scale is not worth it. A session token is 256 bits from the
 * system's cryptographic random source. There is nothing to guess: an attacker
 * with the entire hash table and unlimited hardware still has no path to the
 * original. Slow hashing would buy nothing and would be paid on every single
 * authenticated request, which is the hot path of the whole system.
 *
 * What hashing does buy is the same thing it buys for passwords: a database
 * copy that leaves the building — a nightly backup, a restored snapshot, a disk
 * handed to a supplier — is not a set of working logins.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 bytes. Long past the point where guessing is the attacker's best option. */
const TOKEN_BYTES = 32;

/**
 * base64url, so the value survives a cookie, a header and a URL unescaped.
 * Standard base64 would introduce `+` and `/`, which do not.
 */
export function issueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compares two hashes without leaking where they diverge.
 *
 * Lookup by hash is the normal path and this is not on it; it exists for the
 * places a hash is compared in application code, where an ordinary `===` would
 * be a timing oracle.
 */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
