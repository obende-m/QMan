import {
  BranchId,
  DEFAULT_ROLES,
  DEFAULT_TICKET_TEMPLATE,
  HospitalId,
  QUEUE_NUMBER_PRESETS,
  StationId,
  WorkflowId,
  WorkflowStageId,
  validateHospitalConfiguration,
  validateRoles,
  type ConfigProblem,
  type DisplayBoardConfig,
  type HospitalConfiguration,
  type RoleConfig,
  type AdminEventType,
  type StationConfig,
  type TicketTemplate,
  type Workflow,
} from "@qman/domain";

/**
 * The live hospital configuration.
 *
 * Everything here used to be a frozen constant compiled into the bundle. Making
 * it a mutable, observable store is what turns the administration portal from a
 * mock-up into the real thing: an administrator changes a queue-number template
 * and the station workspace, display board and patient tracker all re-render
 * against the new value with no deploy.
 *
 * The store validates on every write and refuses to commit a change that would
 * leave the hospital in a broken state. Warnings are allowed through — a station
 * with no room set is worth mentioning, and blocking it would only teach
 * administrators to type junk into the field to get past the guard.
 */

export const BRANCH = BranchId("branch-lagos-main");

export const STATION_IDS = {
  reception: StationId("st-reception"),
  vitals: StationId("st-vitals"),
  consultation: StationId("st-consultation"),
  laboratory: StationId("st-laboratory"),
  pharmacy: StationId("st-pharmacy"),
} as const;

function station(
  id: StationId,
  name: string,
  code: string,
  overrides: Partial<Omit<StationConfig, "id" | "name" | "code">> = {},
): StationConfig {
  return {
    id,
    name,
    code,
    room: null,
    staffing: 1,
    serviceEstimateMillis: 10 * 60_000,
    sla: { targetWaitMillis: 30 * 60_000, saturationPoint: 10 },
    queueNumber: QUEUE_NUMBER_PRESETS.numeric(),
    isPublic: true,
    enabled: true,
    ...overrides,
  };
}

function stage(
  stationId: StationId,
  sequence: number,
  overrides: Partial<{
    isRequired: boolean;
    allowSkip: boolean;
    allowRepeat: boolean;
    branchesTo: StationId[];
  }> = {},
) {
  return {
    id: WorkflowStageId(`stage-${sequence}`),
    stationId,
    sequence,
    isRequired: true,
    allowSkip: false,
    allowRepeat: false,
    branchesTo: [] as StationId[],
    ...overrides,
  };
}

export function seedConfiguration(): HospitalConfiguration {
  return {
    profile: {
      id: HospitalId("hosp-demo"),
      name: "Ikeja General Hospital",
      code: "IGH",
      timezone: "Africa/Lagos",
      supportPhone: "+234 800 000 0000",
      brandColor: "#003ec7",
    },
    branches: [
      { id: BRANCH, name: "Main Branch", code: "MAIN", isDefault: true },
    ],
    stations: [
      station(STATION_IDS.reception, "Reception", "REC", {
        room: "Front Desk",
        staffing: 2,
        serviceEstimateMillis: 4 * 60_000,
        sla: { targetWaitMillis: 10 * 60_000, saturationPoint: 10 },
        // Reception's queue is an internal working list, not something a
        // waiting room should be shown.
        isPublic: false,
      }),
      station(STATION_IDS.vitals, "Vitals", "VIT", {
        room: "Room 3",
        staffing: 2,
        serviceEstimateMillis: 6 * 60_000,
        sla: { targetWaitMillis: 15 * 60_000, saturationPoint: 14 },
        queueNumber: QUEUE_NUMBER_PRESETS.departmentPrefix(),
      }),
      station(STATION_IDS.consultation, "Consultation", "OPD", {
        room: "Room 12",
        staffing: 3,
        serviceEstimateMillis: 12 * 60_000,
        sla: { targetWaitMillis: 30 * 60_000, saturationPoint: 12 },
        queueNumber: QUEUE_NUMBER_PRESETS.sequential("A"),
      }),
      station(STATION_IDS.laboratory, "Laboratory", "LAB", {
        room: "Lab Wing, Room 2",
        staffing: 2,
        serviceEstimateMillis: 8 * 60_000,
        sla: { targetWaitMillis: 25 * 60_000, saturationPoint: 8 },
        queueNumber: QUEUE_NUMBER_PRESETS.sequential("L"),
      }),
      station(STATION_IDS.pharmacy, "Pharmacy", "PHR", {
        room: "Ground Floor Counter",
        staffing: 1,
        serviceEstimateMillis: 5 * 60_000,
        sla: { targetWaitMillis: 15 * 60_000, saturationPoint: 10 },
        // Monthly, to show the reset strategy is per station.
        queueNumber: { ...QUEUE_NUMBER_PRESETS.sequential("P"), reset: "monthly" },
      }),
    ],
    workflows: [
      {
        id: WorkflowId("wf-opd"),
        branchId: BRANCH,
        name: "General Outpatient",
        isDefault: true,
        stages: [
          stage(STATION_IDS.reception, 1),
          stage(STATION_IDS.vitals, 2),
          stage(STATION_IDS.consultation, 3, {
            allowRepeat: true,
            branchesTo: [STATION_IDS.laboratory],
          }),
          stage(STATION_IDS.laboratory, 4, {
            isRequired: false,
            branchesTo: [STATION_IDS.consultation],
          }),
          stage(STATION_IDS.pharmacy, 5, { isRequired: false }),
        ],
      },
    ],
    displayBoards: [
      {
        id: "board-main",
        name: "Main Waiting Area",
        stationIds: [
          STATION_IDS.consultation,
          STATION_IDS.laboratory,
          STATION_IDS.pharmacy,
        ],
        waitingToShow: 4,
        namePolicy: "ticket_only",
        showEstimatedWait: true,
        showRoom: true,
      },
      {
        id: "board-lab",
        name: "Laboratory Waiting Area",
        stationIds: [STATION_IDS.laboratory],
        waitingToShow: 8,
        namePolicy: "ticket_only",
        showEstimatedWait: true,
        showRoom: true,
      },
      {
        id: "board-clinic",
        name: "Private Clinic",
        stationIds: [STATION_IDS.vitals, STATION_IDS.consultation],
        waitingToShow: 5,
        namePolicy: "first_name",
        showEstimatedWait: true,
        showRoom: true,
      },
    ],
    ticketTemplates: [
      DEFAULT_TICKET_TEMPLATE,
      {
        id: "ticket-58",
        name: "Compact ticket (58 mm)",
        paper: "thermal_58mm",
        elements: [
          { element: "hospitalName", condition: "always" },
          { element: "queueTicket", condition: "always" },
          { element: "station", condition: "always" },
          { element: "room", condition: "if_present" },
          { element: "journeyCode", condition: "always" },
          { element: "qrCode", condition: "always" },
          { element: "visitTime", condition: "always" },
          { element: "footer", condition: "always" },
        ],
        instructions: "",
        footer: "Scan to track your visit.",
        namePolicy: "ticket_only",
        trackingUrl: "/track.html",
      },
    ],
    defaults: {
      namePolicy: "ticket_only",
      ticketTemplateId: DEFAULT_TICKET_TEMPLATE.id,
    },
  };
}

export type SaveResult =
  | { ok: true; warnings: ConfigProblem[] }
  | { ok: false; problems: ConfigProblem[] };

/**
 * Where administrative changes are recorded.
 *
 * A callback rather than a direct dependency on the operations store: the
 * configuration store must not know what an audit log is, and a hospital that
 * has not wired one still saves configuration.
 */
export interface AdminAuditSink {
  (input: { type: AdminEventType; summary: string }): void;
}

export class ConfigStore {
  #config: HospitalConfiguration = seedConfiguration();
  #roles: RoleConfig[] = DEFAULT_ROLES.map((role) => ({ ...role }));
  #version = 0;
  #listeners = new Set<() => void>();
  #audit: AdminAuditSink | null = null;

  /** Records every successful configuration change from here on. */
  auditTo(sink: AdminAuditSink): this {
    this.#audit = sink;
    return this;
  }

  #record(type: AdminEventType, summary: string): void {
    this.#audit?.({ type, summary });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getVersion = (): number => this.#version;

  get config(): HospitalConfiguration {
    return this.#config;
  }

  get roles(): readonly RoleConfig[] {
    return this.#roles;
  }

  get problems(): ConfigProblem[] {
    return validateHospitalConfiguration(this.#config);
  }

  // ----------------------------------------------------------------- lookups

  station(stationId: StationId): StationConfig | undefined {
    return this.#config.stations.find((s) => s.id === stationId);
  }

  stationName(stationId: StationId): string {
    return this.station(stationId)?.name ?? "Station";
  }

  /** Enabled stations, in configured order. */
  activeStations(): StationConfig[] {
    return this.#config.stations.filter((s) => s.enabled);
  }

  /** Stations a workspace can be opened for — everything except reception. */
  workspaceStations(): StationConfig[] {
    return this.activeStations().filter((s) => s.id !== STATION_IDS.reception);
  }

  publicStations(): StationConfig[] {
    return this.activeStations().filter((s) => s.isPublic);
  }

  defaultWorkflow(): Workflow {
    return (
      this.#config.workflows.find((w) => w.isDefault) ??
      this.#config.workflows[0]!
    );
  }

  board(id: string): DisplayBoardConfig | undefined {
    return this.#config.displayBoards.find((b) => b.id === id);
  }

  ticketTemplate(id?: string): TicketTemplate {
    const wanted = id ?? this.#config.defaults.ticketTemplateId;
    return (
      this.#config.ticketTemplates.find((t) => t.id === wanted) ??
      this.#config.ticketTemplates[0]!
    );
  }

  updateTicketTemplate(
    templateId: string,
    change: Partial<TicketTemplate>,
  ): SaveResult {
    const result = this.update((config) => ({
      ...config,
      ticketTemplates: config.ticketTemplates.map((t) =>
        t.id === templateId ? { ...t, ...change } : t,
      ),
    }));
    if (result.ok) {
      this.#record(
        "config.ticket_template_updated",
        `Ticket template ${this.ticketTemplate(templateId).name} updated`,
      );
    }
    return result;
  }

  setDefaultTicketTemplate(templateId: string): SaveResult {
    return this.update((config) => ({
      ...config,
      defaults: { ...config.defaults, ticketTemplateId: templateId },
    }));
  }

  // ------------------------------------------------------------------ writes

  /**
   * Applies a change, validates the result, and commits only if nothing is
   * broken. Returns the warnings so the portal can show them without blocking.
   */
  update(
    change: (config: HospitalConfiguration) => HospitalConfiguration,
  ): SaveResult {
    const next = change(this.#config);
    const problems = validateHospitalConfiguration(next);
    const errors = problems.filter((p) => p.severity === "error");

    if (errors.length > 0) {
      return { ok: false, problems: errors };
    }

    this.#config = next;
    this.#commit();
    return { ok: true, warnings: problems };
  }

  updateStation(
    stationId: StationId,
    change: Partial<StationConfig>,
  ): SaveResult {
    const before = this.station(stationId);
    const result = this.update((config) => ({
      ...config,
      stations: config.stations.map((s) =>
        s.id === stationId ? { ...s, ...change } : s,
      ),
    }));

    if (result.ok && before) {
      // The specific change is named, not just "a station was updated" — the
      // question being asked later is "who changed this SLA", and an entry that
      // cannot answer it is an entry nobody reads.
      const name = this.station(stationId)?.name ?? before.name;
      if (change.sla) {
        this.#record(
          "config.sla_updated",
          `SLA for ${name} set to ${Math.round(change.sla.targetWaitMillis / 60_000)} minute target`,
        );
      } else if (change.queueNumber) {
        this.#record(
          "config.queue_numbering_updated",
          `Queue numbering for ${name} set to "${change.queueNumber.template}" (${change.queueNumber.reset})`,
        );
      } else {
        this.#record("config.station_updated", `Station ${name} updated`);
      }
    }

    return result;
  }

  updateBoard(
    boardId: string,
    change: Partial<DisplayBoardConfig>,
  ): SaveResult {
    const result = this.update((config) => ({
      ...config,
      displayBoards: config.displayBoards.map((b) =>
        b.id === boardId ? { ...b, ...change } : b,
      ),
    }));

    if (result.ok) {
      const name = this.board(boardId)?.name ?? boardId;
      this.#record(
        "config.display_board_updated",
        change.namePolicy
          ? `Display board ${name} name policy set to ${change.namePolicy}`
          : `Display board ${name} updated`,
      );
    }
    return result;
  }

  updateProfile(change: Partial<HospitalConfiguration["profile"]>): SaveResult {
    const result = this.update((config) => ({
      ...config,
      profile: { ...config.profile, ...change },
    }));
    if (result.ok) {
      this.#record("config.profile_updated", "Hospital profile updated");
    }
    return result;
  }

  updateWorkflow(workflowId: string, change: Partial<Workflow>): SaveResult {
    const result = this.update((config) => ({
      ...config,
      workflows: config.workflows.map((w) =>
        w.id === workflowId ? { ...w, ...change } : w,
      ),
    }));
    if (result.ok) {
      const name =
        this.#config.workflows.find((w) => w.id === workflowId)?.name ??
        workflowId;
      this.#record("config.workflow_updated", `Workflow ${name} updated`);
    }
    return result;
  }

  setDefaultNamePolicy(
    namePolicy: HospitalConfiguration["defaults"]["namePolicy"],
  ): SaveResult {
    const result = this.update((config) => ({
      ...config,
      defaults: { ...config.defaults, namePolicy },
    }));
    if (result.ok) {
      this.#record(
        "config.privacy_updated",
        `Default patient name policy set to ${namePolicy}`,
      );
    }
    return result;
  }

  /**
   * Adds a station. The point of the whole module: a hospital creating Dialysis
   * or MRI writes a row, and every screen picks it up.
   */
  addStation(config: StationConfig): SaveResult {
    const result = this.update((current) => ({
      ...current,
      stations: [...current.stations, config],
    }));
    if (result.ok) {
      this.#record("config.station_added", `Station ${config.name} created`);
    }
    return result;
  }

  addBoard(board: DisplayBoardConfig): SaveResult {
    return this.update((current) => ({
      ...current,
      displayBoards: [...current.displayBoards, board],
    }));
  }

  updateRole(roleId: string, change: Partial<RoleConfig>): SaveResult {
    const next = this.#roles.map((role) =>
      role.id === roleId ? { ...role, ...change } : role,
    );
    const problems = validateRoles(next);
    if (problems.length > 0) {
      return {
        ok: false,
        problems: problems.map((message) => ({
          path: `roles.${roleId}`,
          message,
          severity: "error" as const,
        })),
      };
    }
    const role = next.find((r) => r.id === roleId);
    this.#roles = next;
    this.#commit();
    this.#record(
      "config.station_updated",
      `Role ${role?.name ?? roleId} permissions changed`,
    );
    return { ok: true, warnings: [] };
  }

  #commit(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}

export const configStore = new ConfigStore();
