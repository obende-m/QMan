/**
 * Password hashing.
 *
 * scrypt, from Node's standard library. Not bcrypt or argon2, which are both
 * defensible choices and both native addons — and a native addon is a
 * compilation step at install time on whatever machine a hospital's IT
 * department is using. Something that must build from source is something that
 * eventually fails to build on a Tuesday, in a server room, with a clinic
 * waiting. scrypt is memory-hard, well understood, and already present.
 *
 * The cost parameters are stored beside the digest rather than assumed. Raising
 * them later is then a change to `CURRENT`, and every existing password stays
 * verifiable at the cost it was created with — without which a cost increase
 * would silently invalidate every account in the hospital.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

export interface ScryptParameters {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
}

/**
 * N=16384 costs roughly 16MB and tens of milliseconds per attempt.
 *
 * Chosen to stay well inside Node's 32MB default memory ceiling for scrypt.
 * Higher is better against an attacker and worse for a receptionist signing in
 * on a reused desktop at 8am, which is the trade being made.
 */
export const CURRENT: ScryptParameters = { N: 16384, r: 8, p: 1, keyLength: 64 };

export interface StoredPassword {
  /** `scrypt$N$r$p$<hex>` — the digest and the cost that produced it. */
  readonly hash: string;
  readonly salt: string;
}

export async function hashPassword(
  password: string,
  parameters: ScryptParameters = CURRENT,
): Promise<StoredPassword> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, parameters.keyLength, parameters);
  return {
    hash: `scrypt$${parameters.N}$${parameters.r}$${parameters.p}$${key.toString("hex")}`,
    salt: salt.toString("hex"),
  };
}

function parse(stored: string): { parameters: ScryptParameters; key: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "scrypt") return null;

  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;

  const key = Buffer.from(parts[4]!, "hex");
  if (key.length === 0) return null;

  return { parameters: { N, r, p, keyLength: key.length }, key };
}

/**
 * Verifies a password against a stored digest.
 *
 * Comparison is timing-safe. An ordinary `===` returns faster the earlier two
 * strings differ, which over enough attempts leaks the digest one byte at a
 * time. The length check before it is not a leak: digest length is a property
 * of the algorithm, not of the secret.
 *
 * A malformed or absent digest returns false rather than throwing. Accounts
 * backed by a directory hold no password here, and an exception on that path
 * would distinguish them from accounts with a wrong password — which is exactly
 * the distinction the uniform failure message exists to hide.
 */
export async function verifyPassword(
  password: string,
  stored: string | null,
  salt: string | null,
): Promise<boolean> {
  if (stored === null || salt === null) return false;

  const parsed = parse(stored);
  if (parsed === null) return false;

  let candidate: Buffer;
  try {
    candidate = await derive(
      password,
      Buffer.from(salt, "hex"),
      parsed.parameters.keyLength,
      parsed.parameters,
    );
  } catch {
    return false;
  }

  if (candidate.length !== parsed.key.length) return false;
  return timingSafeEqual(candidate, parsed.key);
}

/**
 * Whether a stored digest was produced at today's cost.
 *
 * A password verified at an old cost can be rehashed at the new one while the
 * plaintext is briefly in hand at sign-in — the only moment it ever is.
 */
export function needsRehash(
  stored: string | null,
  parameters: ScryptParameters = CURRENT,
): boolean {
  if (stored === null) return false;
  const parsed = parse(stored);
  if (parsed === null) return true;
  return (
    parsed.parameters.N !== parameters.N ||
    parsed.parameters.r !== parameters.r ||
    parsed.parameters.p !== parameters.p
  );
}
