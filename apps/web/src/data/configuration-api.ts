/**
 * The configuration API, as the browser sees it.
 *
 * A thin typed surface over the transport layer. It knows the paths and the
 * shapes, and nothing else: no validation, no defaults, no rules about what a
 * legal configuration is. Every one of those lives on the server, and a copy
 * here would be a second opinion that eventually disagrees with the first.
 *
 * Every write returns the configuration that resulted. That is what makes cache
 * invalidation exact rather than approximate — the store does not re-fetch and
 * hope, it replaces what it holds with what the server just committed. A
 * re-fetch would open a window in which another administrator's change is read
 * as the effect of this one.
 */
import type {
  ConfigProblem,
  HospitalConfiguration,
  Permission,
  RoleConfig,
} from "@qman/domain";
import type { ApiClient } from "../api/client.js";

export interface ConfigurationSnapshot {
  readonly configuration: HospitalConfiguration;
  /** The domain's verdict, computed server-side and returned with it. */
  readonly problems: readonly ConfigProblem[];
}

export interface WriteResult {
  readonly configuration: HospitalConfiguration;
  /** Non-blocking problems. The change was saved; these are worth showing. */
  readonly warnings: readonly ConfigProblem[];
}

/** The shape the server answers a rejected write with. */
export interface RejectedWrite {
  readonly error: string;
  readonly problems: readonly ConfigProblem[];
}

export class ConfigurationApi {
  constructor(private readonly client: ApiClient) {}

  read(): Promise<ConfigurationSnapshot> {
    return this.client.get<ConfigurationSnapshot>("/api/v1/config");
  }

  roles(): Promise<{ roles: readonly RoleConfig[] }> {
    return this.client.get<{ roles: readonly RoleConfig[] }>("/api/v1/roles");
  }

  // ------------------------------------------------------------------ stations

  createStation(patch: Record<string, unknown>): Promise<WriteResult> {
    return this.client.post<WriteResult>("/api/v1/stations", patch);
  }

  updateStation(id: string, patch: Record<string, unknown>): Promise<WriteResult> {
    return this.patch(`/api/v1/stations/${encodeURIComponent(id)}`, patch);
  }

  deleteStation(id: string): Promise<WriteResult> {
    return this.remove(`/api/v1/stations/${encodeURIComponent(id)}`);
  }

  // ----------------------------------------------------------------- workflows

  createWorkflow(patch: Record<string, unknown>): Promise<WriteResult> {
    return this.client.post<WriteResult>("/api/v1/workflows", patch);
  }

  updateWorkflow(id: string, patch: Record<string, unknown>): Promise<WriteResult> {
    return this.patch(`/api/v1/workflows/${encodeURIComponent(id)}`, patch);
  }

  deleteWorkflow(id: string): Promise<WriteResult> {
    return this.remove(`/api/v1/workflows/${encodeURIComponent(id)}`);
  }

  // ------------------------------------------------------------- display boards

  createBoard(patch: Record<string, unknown>): Promise<WriteResult> {
    return this.client.post<WriteResult>("/api/v1/display-boards", patch);
  }

  updateBoard(id: string, patch: Record<string, unknown>): Promise<WriteResult> {
    return this.patch(`/api/v1/display-boards/${encodeURIComponent(id)}`, patch);
  }

  deleteBoard(id: string): Promise<WriteResult> {
    return this.remove(`/api/v1/display-boards/${encodeURIComponent(id)}`);
  }

  // ----------------------------------------------------------- ticket templates

  createTicketTemplate(patch: Record<string, unknown>): Promise<WriteResult> {
    return this.client.post<WriteResult>("/api/v1/ticket-templates", patch);
  }

  updateTicketTemplate(id: string, patch: Record<string, unknown>): Promise<WriteResult> {
    return this.patch(`/api/v1/ticket-templates/${encodeURIComponent(id)}`, patch);
  }

  deleteTicketTemplate(id: string): Promise<WriteResult> {
    return this.remove(`/api/v1/ticket-templates/${encodeURIComponent(id)}`);
  }

  // ------------------------------------------------------- profile and defaults

  updateProfile(patch: Record<string, unknown>): Promise<WriteResult> {
    return this.patch("/api/v1/profile", patch);
  }

  updateDefaults(patch: Record<string, unknown>): Promise<WriteResult> {
    return this.patch("/api/v1/settings", patch);
  }

  // --------------------------------------------------------------------- roles

  createRole(patch: { name: string; description?: string; permissions: readonly Permission[] }): Promise<{
    roles: readonly RoleConfig[];
  }> {
    return this.client.post("/api/v1/roles", patch);
  }

  updateRole(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<{ roles: readonly RoleConfig[] }> {
    return this.client.request(`/api/v1/roles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
  }

  deleteRole(id: string): Promise<{ roles: readonly RoleConfig[] }> {
    return this.client.request(`/api/v1/roles/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  private patch(path: string, body: Record<string, unknown>): Promise<WriteResult> {
    return this.client.request<WriteResult>(path, { method: "PATCH", body });
  }

  private remove(path: string): Promise<WriteResult> {
    return this.client.request<WriteResult>(path, { method: "DELETE" });
  }
}
