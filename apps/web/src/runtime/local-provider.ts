import {
  invalidCredentials,
  type AuthOutcome,
  type IdentityProvider,
  type PasswordCredentials,
  type UserAccount,
} from "@qman/domain";

/**
 * Local username-and-password authentication.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY NOTE — READ BEFORE DEPLOYING
 *
 * This implementation verifies passwords **in the browser**, because QMan has
 * no server yet. That is not a secure design and is not intended to survive:
 * password hashes must never be sent to a client, and verification must happen
 * server-side where the hash and the comparison are out of the user's reach.
 *
 * It exists so the sign-in flow, session handling, lockout and permission
 * gating can be built and tested now, and so the `IdentityProvider` port has a
 * working implementation behind it. When persistence lands, this class is
 * replaced by one that posts credentials to an endpoint — every screen above
 * it is unchanged, which is the point of the port.
 *
 * The hashing below is PBKDF2-SHA256 with a per-account salt: correct in shape,
 * so moving it server-side is a relocation rather than a rewrite.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ITERATIONS = 210_000;
const KEY_LENGTH = 32;

export interface StoredCredential {
  readonly username: string;
  readonly salt: string;
  readonly hash: string;
  readonly account: UserAccount;
}

export async function hashPassword(
  password: string,
  salt: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    key,
    KEY_LENGTH * 8,
  );

  return [...new Uint8Array(bits)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function randomSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time comparison.
 *
 * A `===` on hashes leaks timing information about how many leading characters
 * matched. Cheap to avoid, so avoided.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

export class LocalIdentityProvider implements IdentityProvider {
  readonly id = "local";
  readonly name = "QMan account";
  readonly kind = "password" as const;
  readonly enabled = true;

  #credentials = new Map<string, StoredCredential>();

  async addAccount(
    account: UserAccount,
    password: string,
  ): Promise<StoredCredential> {
    const salt = randomSalt();
    const hash = await hashPassword(password, salt);
    const stored: StoredCredential = {
      username: account.username.toLowerCase(),
      salt,
      hash,
      account,
    };
    this.#credentials.set(stored.username, stored);
    return stored;
  }

  async changePassword(username: string, password: string): Promise<boolean> {
    const existing = this.#credentials.get(username.toLowerCase());
    if (!existing) return false;
    const salt = randomSalt();
    this.#credentials.set(existing.username, {
      ...existing,
      salt,
      hash: await hashPassword(password, salt),
    });
    return true;
  }

  async authenticate(credentials: PasswordCredentials): Promise<AuthOutcome> {
    const stored = this.#credentials.get(
      credentials.username.trim().toLowerCase(),
    );

    if (!stored) {
      // Hash anyway. Returning immediately for an unknown username makes the
      // response measurably faster and turns login into a username oracle.
      await hashPassword(credentials.password, randomSalt());
      return invalidCredentials();
    }

    const attempt = await hashPassword(credentials.password, stored.salt);
    if (!timingSafeEqual(attempt, stored.hash)) {
      return invalidCredentials();
    }

    if (!stored.account.enabled) {
      return {
        ok: false,
        reason: "account_disabled",
        message: "This account has been disabled. Contact your administrator.",
      };
    }

    return { ok: true, account: stored.account };
  }
}
