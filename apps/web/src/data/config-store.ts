/**
 * The hospital configuration, as the browser holds it.
 *
 * A cache of what the server said, and nothing more. It used to be the source
 * of truth — it seeded a hospital, validated changes and decided what was
 * legal — and every one of those responsibilities now belongs to the API. What
 * is left is the part a browser genuinely needs: somewhere to keep the answer
 * so that eight components rendering at once do not each fetch it.
 *
 * Three consequences worth stating.
 *
 * **There is no validation here.** A write is sent and the server decides. A
 * copy of `validateHospitalConfiguration` in the browser would be a second
 * opinion, and it would win every disagreement by answering first and without a
 * network.
 *
 * **Writes replace the cache from the response, never from the request.** Every
 * configuration endpoint returns the configuration that resulted, so what is
 * held afterwards is what was committed rather than what was asked for. That
 * matters when the server normalises something, and more when a change is
 * refused: the browser is never left believing an edit landed that did not.
 *
 * **Nothing is optimistic.** Configuration changes are rare, deliberate and
 * consequential. A screen showing a new SLA before the server accepted it would
 * be lying about a number the hospital is measured against. Queue actions are
 * where optimism earns its keep; this is not that.
 */
import type {
  ConfigProblem,
  DisplayBoardConfig,
  HospitalConfiguration,
  Permission,
  RoleConfig,
  StationConfig,
  StationId,
  TicketTemplate,
  Workflow,
} from "@qman/domain";
import { ApiError } from "../api/client.js";
import type { ConfigurationApi } from "./configuration-api.js";

export type SaveResult =
  | { ok: true; warnings: readonly ConfigProblem[] }
  | { ok: false; problems: readonly ConfigProblem[] };

/**
 * Whether the configuration is usable yet.
 *
 * A surface cannot render a queue without knowing the stations, so this is not
 * a spinner detail — it is the difference between a screen that is empty and a
 * screen that is wrong. `failed` is distinct from `loading` because a waiting
 * room showing "loading" forever is indistinguishable from a working one, and
 * staff will wait rather than call anybody.
 */
export type ConfigStatus = "loading" | "ready" | "failed";

function problemsFrom(error: unknown): readonly ConfigProblem[] {
  if (error instanceof ApiError) {
    if (error.problems.length > 0) return error.problems as readonly ConfigProblem[];
    return [{ path: "", message: error.message, severity: "error" }];
  }
  return [{ path: "", message: "That change could not be saved.", severity: "error" }];
}

export class ConfigStore {
  #config: HospitalConfiguration | null = null;
  #roles: readonly RoleConfig[] = [];
  #problems: readonly ConfigProblem[] = [];
  #status: ConfigStatus = "loading";
  #error: ApiError | null = null;
  #version = 0;
  #listeners = new Set<() => void>();

  constructor(private readonly api: ConfigurationApi) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getVersion = (): number => this.#version;

  get status(): ConfigStatus {
    return this.#status;
  }

  /**
   * The failure that stopped the configuration loading.
   *
   * Carried rather than flattened to a message, so a surface can tell an
   * expired session from an unreachable server and quote the request id when it
   * is neither.
   */
  get error(): ApiError | null {
    return this.#error;
  }

  get loaded(): boolean {
    return this.#config !== null;
  }

  /**
   * Throws when the configuration has not arrived.
   *
   * Deliberately not an empty hospital. Rendering a queue against one produces
   * a screen that looks like a quiet clinic rather than one that failed, and a
   * waiting room cannot tell the difference. Callers render behind the status
   * gate; reaching this without it is a bug worth failing on.
   */
  get config(): HospitalConfiguration {
    if (this.#config === null) {
      throw new Error("Configuration has not loaded. Render behind the configuration gate.");
    }
    return this.#config;
  }

  get roles(): readonly RoleConfig[] {
    return this.#roles;
  }

  /** The server's verdict, not a second opinion computed here. */
  get problems(): readonly ConfigProblem[] {
    return this.#problems;
  }

  // ----------------------------------------------------------------- lifecycle

  async load(): Promise<void> {
    try {
      const snapshot = await this.api.read();
      this.#config = snapshot.configuration;
      this.#problems = snapshot.problems;
      this.#status = "ready";
      this.#error = null;
    } catch (error) {
      this.#status = "failed";
      this.#error = error instanceof ApiError ? error : null;
    }
    this.#commit();
  }

  /**
   * Loads roles, which most surfaces never need.
   *
   * Separate because reading them requires `admin.users`: a receptionist asking
   * for the configuration must not be refused it because the same request also
   * tried to enumerate who can do what.
   */
  async loadRoles(): Promise<void> {
    try {
      this.#roles = (await this.api.roles()).roles;
    } catch {
      // A caller without the permission has no roles to show, and the portal
      // already hides the section. Failing the whole screen would be worse
      // than an empty list nobody can reach.
      this.#roles = [];
    }
    this.#commit();
  }

  // ------------------------------------------------------------------- lookups

  station(stationId: StationId): StationConfig | undefined {
    return this.config.stations.find((s) => s.id === stationId);
  }

  stationName(stationId: StationId): string {
    return this.station(stationId)?.name ?? "Station";
  }

  activeStations(): StationConfig[] {
    return this.config.stations.filter((s) => s.enabled);
  }

  /**
   * Stations a workspace can be opened for.
   *
   * Reception is excluded by what it is rather than by a seeded identifier: a
   * station that issues the first ticket has no queue of its own to work.
   */
  workspaceStations(): StationConfig[] {
    return this.activeStations().filter((s) => s.code.toUpperCase() !== "REC");
  }

  publicStations(): StationConfig[] {
    return this.activeStations().filter((s) => s.isPublic);
  }

  defaultWorkflow(): Workflow | undefined {
    const workflows = this.config.workflows;
    return workflows.find((w) => w.isDefault) ?? workflows[0];
  }

  board(id: string): DisplayBoardConfig | undefined {
    return this.config.displayBoards.find((b) => b.id === id);
  }

  ticketTemplate(id?: string): TicketTemplate | undefined {
    const wanted = id ?? this.config.defaults.ticketTemplateId;
    return (
      this.config.ticketTemplates.find((t) => t.id === wanted) ?? this.config.ticketTemplates[0]
    );
  }

  // -------------------------------------------------------------------- writes

  addStation(patch: Record<string, unknown>): Promise<SaveResult> {
    return this.#write(() => this.api.createStation(patch));
  }

  updateStation(stationId: StationId, change: Partial<StationConfig>): Promise<SaveResult> {
    return this.#write(() =>
      this.api.updateStation(stationId, change as Record<string, unknown>),
    );
  }

  removeStation(stationId: StationId): Promise<SaveResult> {
    return this.#write(() => this.api.deleteStation(stationId));
  }

  addWorkflow(patch: Record<string, unknown>): Promise<SaveResult> {
    return this.#write(() => this.api.createWorkflow(patch));
  }

  updateWorkflow(workflowId: string, change: Partial<Workflow>): Promise<SaveResult> {
    return this.#write(() =>
      this.api.updateWorkflow(workflowId, change as Record<string, unknown>),
    );
  }

  removeWorkflow(workflowId: string): Promise<SaveResult> {
    return this.#write(() => this.api.deleteWorkflow(workflowId));
  }

  addBoard(patch: Record<string, unknown>): Promise<SaveResult> {
    return this.#write(() => this.api.createBoard(patch));
  }

  updateBoard(boardId: string, change: Partial<DisplayBoardConfig>): Promise<SaveResult> {
    return this.#write(() => this.api.updateBoard(boardId, change as Record<string, unknown>));
  }

  removeBoard(boardId: string): Promise<SaveResult> {
    return this.#write(() => this.api.deleteBoard(boardId));
  }

  addTicketTemplate(patch: Record<string, unknown>): Promise<SaveResult> {
    return this.#write(() => this.api.createTicketTemplate(patch));
  }

  updateTicketTemplate(
    templateId: string,
    change: Partial<TicketTemplate>,
  ): Promise<SaveResult> {
    return this.#write(() =>
      this.api.updateTicketTemplate(templateId, change as Record<string, unknown>),
    );
  }

  removeTicketTemplate(templateId: string): Promise<SaveResult> {
    return this.#write(() => this.api.deleteTicketTemplate(templateId));
  }

  setDefaultTicketTemplate(templateId: string): Promise<SaveResult> {
    return this.#write(() => this.api.updateDefaults({ ticketTemplateId: templateId }));
  }

  updateProfile(change: Partial<HospitalConfiguration["profile"]>): Promise<SaveResult> {
    return this.#write(() => this.api.updateProfile(change as Record<string, unknown>));
  }

  setDefaultNamePolicy(
    namePolicy: HospitalConfiguration["defaults"]["namePolicy"],
  ): Promise<SaveResult> {
    return this.#write(() => this.api.updateDefaults({ namePolicy }));
  }

  // --------------------------------------------------------------------- roles

  addRole(name: string, permissions: readonly Permission[]): Promise<SaveResult> {
    return this.#writeRoles(() => this.api.createRole({ name, permissions }));
  }

  updateRole(
    roleId: string,
    change: { name?: string; description?: string; permissions?: readonly Permission[] },
  ): Promise<SaveResult> {
    return this.#writeRoles(() => this.api.updateRole(roleId, change));
  }

  removeRole(roleId: string): Promise<SaveResult> {
    return this.#writeRoles(() => this.api.deleteRole(roleId));
  }

  /**
   * One write, one cache replacement, one notification.
   *
   * The configuration held afterwards is the one the server returned, so a
   * change that was normalised is reflected exactly rather than assumed.
   * Nothing changes on failure: the previous configuration is the one still in
   * force.
   */
  async #write(
    send: () => Promise<{
      configuration: HospitalConfiguration;
      warnings: readonly ConfigProblem[];
    }>,
  ): Promise<SaveResult> {
    try {
      const result = await send();
      this.#config = result.configuration;
      this.#problems = result.warnings;
      this.#commit();
      return { ok: true, warnings: result.warnings };
    } catch (error) {
      return { ok: false, problems: problemsFrom(error) };
    }
  }

  async #writeRoles(
    send: () => Promise<{ roles: readonly RoleConfig[] }>,
  ): Promise<SaveResult> {
    try {
      this.#roles = (await send()).roles;
      this.#commit();
      return { ok: true, warnings: [] };
    } catch (error) {
      return { ok: false, problems: problemsFrom(error) };
    }
  }

  #commit(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}
