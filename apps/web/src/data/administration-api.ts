/**
 * Account, session and branch administration, as the browser reaches it.
 *
 * Thin by design: every rule — who may be disabled, which role exists, which
 * branch belongs to whom — is the server's, and these calls only carry the
 * request and the answer.
 */
import type { ApiClient } from "../api/client.js";

export interface AccountSummary {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly branchIds: readonly string[];
  readonly enabled: boolean;
  readonly providerId: string;
  readonly passwordChangeRequired: boolean;
  readonly lastSignInAt: string | null;
  readonly createdAt: string;
  readonly lockedUntil: string | null;
}

export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly username: string;
  readonly branchId: string | null;
  readonly device: string;
  readonly startedAt: string;
  readonly lastActiveAt: string;
  readonly current: boolean;
}

export interface BranchRow {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly isDefault: boolean;
}

export class AdministrationApi {
  constructor(private readonly client: ApiClient) {}

  /** Names for ids, for dashboards. Needs `reports.view` only. */
  staff(): Promise<{ staff: Array<{ id: string; displayName: string }> }> {
    return this.client.get("/api/v1/staff");
  }

  users(): Promise<{ users: AccountSummary[] }> {
    return this.client.get("/api/v1/users");
  }

  createUser(input: {
    username: string;
    displayName: string;
    roleId: string;
    branchIds: string[];
  }): Promise<{ user: AccountSummary; temporaryPassword: string }> {
    return this.client.post("/api/v1/users", input);
  }

  updateUser(
    id: string,
    changes: Partial<{ displayName: string; roleId: string; branchIds: string[]; enabled: boolean }>,
  ): Promise<{ user: AccountSummary }> {
    return this.client.request(`/api/v1/users/${encodeURIComponent(id)}`, { method: "PATCH", body: changes });
  }

  resetPassword(id: string): Promise<{ temporaryPassword: string }> {
    return this.client.post(`/api/v1/users/${encodeURIComponent(id)}/reset-password`);
  }

  unlock(id: string): Promise<void> {
    return this.client.post(`/api/v1/users/${encodeURIComponent(id)}/unlock`);
  }

  sessions(): Promise<{ sessions: SessionRow[] }> {
    return this.client.get("/api/v1/sessions");
  }

  revokeSession(id: string): Promise<void> {
    return this.client.post(`/api/v1/sessions/${encodeURIComponent(id)}/revoke`);
  }

  branches(): Promise<{ branches: BranchRow[] }> {
    return this.client.get("/api/v1/branches");
  }

  createBranch(input: { name: string; code: string }): Promise<{ branch: BranchRow }> {
    return this.client.post("/api/v1/branches", input);
  }

  updateBranch(id: string, changes: Partial<{ name: string; code: string; isDefault: true }>): Promise<{ branch: BranchRow }> {
    return this.client.request(`/api/v1/branches/${encodeURIComponent(id)}`, { method: "PATCH", body: changes });
  }
}
