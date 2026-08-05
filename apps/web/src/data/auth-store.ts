/**
 * Who is signed in.
 *
 * A cache of what `/auth/me` said, and nothing more. Passwords are verified on
 * the server, the session lives in an HttpOnly cookie this code cannot read,
 * and permissions arrive already resolved. The browser's only job is to
 * remember the answer between renders.
 *
 * `can()` exists so a screen can avoid drawing a button the caller may not use.
 * It is a courtesy, not a control: the same permission is enforced on every
 * request, and a hidden button is a request anyone can still make with a
 * terminal. A screen that treats this as security has misread it.
 */
import type { Permission } from "@qman/domain";
import { ApiError } from "../api/client.js";
import type { AuthApi, SignedInUser } from "./auth-api.js";

export type AuthStatus = "loading" | "signed_in" | "signed_out";

export type SignInResult =
  | { ok: true; user: SignedInUser }
  | { ok: false; message: string; retryAfter?: string };

export class AuthStore {
  #user: SignedInUser | null = null;
  #status: AuthStatus = "loading";
  #version = 0;
  #listeners = new Set<() => void>();

  constructor(private readonly api: AuthApi) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getVersion = (): number => this.#version;

  get status(): AuthStatus {
    return this.#status;
  }

  currentUser(): SignedInUser | null {
    return this.#user;
  }

  /**
   * Whether the signed-in user holds a permission.
   *
   * False when nobody is signed in, rather than throwing: a screen rendering in
   * the moment before `/auth/me` returns should draw its restricted parts
   * hidden and then reveal them, not crash.
   */
  can(permission: Permission): boolean {
    return this.#user?.permissions.includes(permission) ?? false;
  }

  /** Resolves the session the cookie already carries, if any. */
  async load(): Promise<void> {
    try {
      this.#user = (await this.api.me()).user;
      this.#status = "signed_in";
    } catch {
      // Any failure here means "not signed in as far as this browser is
      // concerned". Distinguishing an expired session from an unreachable
      // server would change nothing: both lead to the sign-in screen.
      this.#user = null;
      this.#status = "signed_out";
    }
    this.#commit();
  }

  async signIn(username: string, password: string): Promise<SignInResult> {
    try {
      const response = await this.api.signIn(username, password);
      this.#user = response.user;
      this.#status = "signed_in";
      this.#commit();
      return { ok: true, user: response.user };
    } catch (error) {
      if (error instanceof ApiError) {
        return { ok: false, message: error.message };
      }
      return { ok: false, message: "Could not sign in. Try again." };
    }
  }

  async signOut(): Promise<void> {
    try {
      await this.api.signOut();
    } finally {
      // Cleared whether or not the server answered. A browser still showing a
      // signed-in user after someone pressed Sign out — on a shared reception
      // desk — is worse than one that clears optimistically.
      this.#user = null;
      this.#status = "signed_out";
      this.#commit();
    }
  }

  /**
   * Re-checks the session on activity.
   *
   * The server advances the idle timeout on every authenticated request, so
   * this doubles as the keepalive. A failure means the session ended, which
   * `load` already handles by signing out.
   */
  async touchCurrent(): Promise<void> {
    if (this.#status !== "signed_in") return;
    await this.load();
  }

  #commit(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}
