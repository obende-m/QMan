/**
 * The authentication API, as the browser sees it.
 *
 * Three calls, mirroring the other clients. There is no password handling here
 * and no session storage: the credential goes out once and comes back as an
 * HttpOnly cookie this code cannot read, which is the point.
 */
import type { Permission } from "@qman/domain";
import type { ApiClient } from "../api/client.js";

export interface SignedInUser {
  readonly id: string;
  readonly displayName: string;
  readonly username: string;
  readonly roleId: string;
  readonly branchId: string | null;
  readonly branchIds: readonly string[];
  readonly permissions: readonly Permission[];
}

export interface SignInResponse {
  readonly user: SignedInUser;
  /** Also set as a readable cookie; returned so a client need not parse one. */
  readonly csrfToken: string;
}

export class AuthApi {
  constructor(private readonly client: ApiClient) {}

  signIn(username: string, password: string): Promise<SignInResponse> {
    return this.client.post<SignInResponse>("/api/v1/auth/login", { username, password });
  }

  me(): Promise<{ user: SignedInUser }> {
    return this.client.get<{ user: SignedInUser }>("/api/v1/auth/me");
  }

  signOut(): Promise<void> {
    return this.client.post<void>("/api/v1/auth/logout");
  }
}
