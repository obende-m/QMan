/**
 * The Platform API client.
 *
 * Mirrors the organization clients and talks to a different tree. Nothing here
 * reads or writes a hospital's configuration, visits or staff — the platform
 * surface has no route to them, and adding one would mean adding it to the
 * server first, where the guard would refuse it.
 */
import type { ApiClient } from "../api/client.js";

export interface PlatformUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: string;
  readonly permissions: readonly string[];
}

export interface OrganizationSummary {
  /** Immutable, and the only value anything keys on. */
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: "active" | "suspended";
  readonly timezone: string;
  readonly suspendedAt: string | null;
  readonly suspendedReason: string | null;
  readonly createdAt: string;
  readonly branchCount: number;
  readonly userCount: number;
}

export interface PlatformAuditEvent {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly actorId: string | null;
  readonly organizationId: string | null;
  readonly correlationId: string | null;
  readonly at: string;
  readonly summary: string;
}

export interface PlatformHealth {
  readonly organizations: { total: number; active: number; suspended: number };
  readonly branches: number;
  readonly users: number;
  readonly platformAdministrators: number;
  readonly at: string;
}

export interface NewOrganization {
  readonly code: string;
  readonly name: string;
  readonly timezone: string;
  readonly branchName: string;
  readonly adminUsername: string;
  readonly adminDisplayName: string;
}

/** Shown once, never stored. The caller displays it and forgets it. */
export interface IssuedCredentials {
  readonly username: string;
  readonly password: string;
}

const P = "/api/v1/platform";

export class PlatformApi {
  constructor(private readonly client: ApiClient) {}

  signIn(username: string, password: string): Promise<{ user: PlatformUser }> {
    return this.client.post<{ user: PlatformUser }>(`${P}/auth/login`, { username, password });
  }

  signOut(): Promise<void> {
    return this.client.post<void>(`${P}/auth/logout`, {});
  }

  me(): Promise<{ user: PlatformUser }> {
    return this.client.get<{ user: PlatformUser }>(`${P}/auth/me`);
  }

  organizations(): Promise<{ organizations: OrganizationSummary[] }> {
    return this.client.get<{ organizations: OrganizationSummary[] }>(`${P}/organizations`);
  }

  createOrganization(input: NewOrganization): Promise<{
    organization: OrganizationSummary;
    administrator: IssuedCredentials;
  }> {
    return this.client.post(`${P}/organizations`, input);
  }

  suspend(id: string, reason: string): Promise<{ organization: OrganizationSummary }> {
    return this.client.post(`${P}/organizations/${id}/suspend`, { reason });
  }

  reactivate(id: string): Promise<{ organization: OrganizationSummary }> {
    return this.client.post(`${P}/organizations/${id}/reactivate`, {});
  }

  resetAdministrator(id: string, username: string): Promise<{ administrator: IssuedCredentials }> {
    return this.client.post(`${P}/organizations/${id}/admin-reset`, { username });
  }

  audit(organizationId?: string): Promise<{ events: PlatformAuditEvent[] }> {
    const query = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";
    return this.client.get<{ events: PlatformAuditEvent[] }>(`${P}/audit${query}`);
  }

  health(): Promise<PlatformHealth> {
    return this.client.get<PlatformHealth>(`${P}/health`);
  }
}
