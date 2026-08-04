import type { BranchId, UserId } from "../shared/ids.js";
import type { Permission } from "../configuration/rbac.js";

/**
 * Identity.
 *
 * QMan will not be the system of record for hospital identity for long — most
 * hospitals large enough to want it already run Active Directory, and the first
 * question their IT department asks is whether staff need another password.
 * So authentication is a port from the start, with local password auth as one
 * implementation rather than as the design.
 *
 * The rest of the application depends on `AuthenticatedUser` and never on how
 * that user proved who they are. Adding SAML later adds a provider; it does not
 * touch a screen.
 */

export interface UserAccount {
  readonly id: UserId;
  readonly displayName: string;
  /** The login identifier — username, email, or a directory principal. */
  readonly username: string;
  readonly roleId: string;
  /**
   * Branches this user may work in. Empty means every branch, which is how a
   * single-site hospital avoids configuring something it does not have.
   */
  readonly branchIds: readonly BranchId[];
  /** Which provider owns this account. Local accounts can hold a password. */
  readonly providerId: string;
  readonly enabled: boolean;
}

/** A user who has proved who they are, with their resolved permissions. */
export interface AuthenticatedUser {
  readonly account: UserAccount;
  readonly permissions: readonly Permission[];
  readonly branchId: BranchId | null;
}

export type AuthFailureReason =
  | "invalid_credentials"
  | "account_disabled"
  | "account_locked"
  | "provider_unavailable"
  | "password_expired";

export type AuthOutcome =
  | { readonly ok: true; readonly account: UserAccount }
  | {
      readonly ok: false;
      readonly reason: AuthFailureReason;
      /** Safe to show a user. Never leaks whether the username exists. */
      readonly message: string;
      /** Present when the account is locked, so the UI can say how long. */
      readonly retryAfter?: Date;
    };

export interface PasswordCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * An authentication provider.
 *
 * `password` providers take credentials directly. `redirect` providers hand the
 * browser to an external identity service and complete on return — the shape
 * SSO, OAuth, OIDC and SAML all take.
 */
export interface IdentityProvider {
  readonly id: string;
  readonly name: string;
  readonly kind: "password" | "redirect";
  readonly enabled: boolean;
  /** Password providers only. */
  authenticate?(credentials: PasswordCredentials): Promise<AuthOutcome>;
  /** Redirect providers only: where to send the browser. */
  authorizationUrl?(returnTo: string): string;
  /** Redirect providers only: complete a return from the identity service. */
  complete?(params: URLSearchParams): Promise<AuthOutcome>;
}

/**
 * A deliberately uniform failure message.
 *
 * Distinguishing "no such user" from "wrong password" tells an attacker which
 * usernames are real. The lockout path is the one exception, because a user
 * genuinely locked out needs to know why they cannot get in.
 */
export const GENERIC_AUTH_FAILURE =
  "That username or password is not correct.";

export function invalidCredentials(): AuthOutcome {
  return {
    ok: false,
    reason: "invalid_credentials",
    message: GENERIC_AUTH_FAILURE,
  };
}
