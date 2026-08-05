/**
 * Reading the hospital's configuration.
 *
 * One source of truth: these tables. The browser held a copy while there was no
 * server to ask, and two copies of a configuration is two answers to "how long
 * should the consultation queue be before it is saturated" — with no way to
 * tell which one the SLA on the manager's screen was computed against.
 *
 * Assembled in one round trip per table rather than per row. A configuration
 * read happens on every page load of every surface, and a station-by-station
 * query would make opening a display board an N+1 against a database that may
 * be a continent away.
 */
import {
  PERMISSIONS,
  BranchId,
  HospitalId,
  StationId,
  WorkflowId,
  type DisplayBoardConfig,
  type HospitalConfiguration,
  type PatientNamePolicy,
  type Permission,
  type TicketElementSpec,
  type RoleConfig,
  type TicketTemplate,
  type Workflow,
} from "@qman/domain";
import { toStationConfig, toWorkflow } from "./mappers.js";
import type { StationRow, WorkflowRow, WorkflowStageRow } from "./rows.js";
import type { Database, SqlExecutor } from "./sql.js";

export interface HospitalRow {
  id: string;
  name: string;
  code: string;
  timezone: string;
  support_phone: string | null;
  brand_color: string;
}

export interface BranchRow {
  id: string;
  name: string;
  code: string;
  is_default: boolean;
}

export interface DisplayBoardRow {
  id: string;
  branch_id: string;
  name: string;
  station_ids: string[];
  waiting_to_show: number;
  name_policy: string;
  show_estimated_wait: boolean;
  show_room: boolean;
}

export interface TicketTemplateRow {
  id: string;
  name: string;
  paper: string;
  elements: TicketElementSpec[];
  instructions: string;
  footer: string;
  name_policy: string;
  tracking_url: string;
}

export interface SettingsRow {
  settings: {
    namePolicy?: string;
    ticketTemplateId?: string;
  };
}

export interface ConfigurationRepository {
  load(hospitalId: string): Promise<HospitalConfiguration | null>;
  loadRoles(hospitalId: string): Promise<RoleConfig[]>;
}

/**
 * A stored policy the domain does not recognise falls back to the safest one.
 *
 * The failure mode being avoided is specific: an unreadable policy must never
 * resolve to "show the full name". Defaulting to ticket-only means a corrupt or
 * newer value costs a little usefulness on a screen rather than putting a
 * patient's name in a waiting room.
 */
const NAME_POLICIES: readonly string[] = ["ticket_only", "first_name", "full_name"];

export function toNamePolicy(value: string): PatientNamePolicy {
  return (NAME_POLICIES.includes(value) ? value : "ticket_only") as PatientNamePolicy;
}

interface RoleRow {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  is_system: boolean;
}

export class PostgresConfigurationRepository implements ConfigurationRepository {
  /**
   * A `SqlExecutor`, not a `Database`. Reads need only `query`, and taking the
   * narrower port means the same repository can run against a transaction —
   * which is what lets a write load, validate and persist without another
   * writer changing the configuration underneath it.
   */
  constructor(private readonly db: SqlExecutor) {}

  /**
   * Permissions the domain does not recognise are dropped, matching how an
   * account's grant is read. A role configured by a newer build costs its
   * holders a button; failing the read would lock them out of a running clinic.
   */
  async loadRoles(hospitalId: string): Promise<RoleConfig[]> {
    const rows = await this.db.query<RoleRow>(
      `SELECT id, name, description, permissions, is_system FROM roles
       WHERE hospital_id = $1 ORDER BY name`,
      [hospitalId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      permissions: row.permissions.filter(
        (value): value is Permission => value in PERMISSIONS,
      ),
      isSystem: row.is_system,
    }));
  }

  async load(hospitalId: string): Promise<HospitalConfiguration | null> {
    const [hospital] = await this.db.query<HospitalRow>(
      `SELECT id, name, code, timezone, support_phone, brand_color
       FROM hospitals WHERE id = $1`,
      [hospitalId],
    );
    if (hospital === undefined) return null;

    const [branches, stations, workflows, stages, boards, templates, settings] =
      await Promise.all([
        this.db.query<BranchRow>(
          `SELECT id, name, code, is_default FROM branches
           WHERE hospital_id = $1 ORDER BY name`,
          [hospitalId],
        ),
        this.db.query<StationRow>(
          `SELECT s.* FROM stations s
           JOIN branches b ON b.id = s.branch_id
           WHERE b.hospital_id = $1 ORDER BY s.name`,
          [hospitalId],
        ),
        this.db.query<WorkflowRow>(
          `SELECT w.* FROM workflows w
           JOIN branches b ON b.id = w.branch_id
           WHERE b.hospital_id = $1 ORDER BY w.name`,
          [hospitalId],
        ),
        this.db.query<WorkflowStageRow>(
          `SELECT st.* FROM workflow_stages st
           JOIN workflows w ON w.id = st.workflow_id
           JOIN branches b ON b.id = w.branch_id
           WHERE b.hospital_id = $1 ORDER BY st.sequence`,
          [hospitalId],
        ),
        this.db.query<DisplayBoardRow>(
          `SELECT d.id, d.branch_id, d.name, d.station_ids, d.waiting_to_show,
                  d.name_policy, d.show_estimated_wait, d.show_room
           FROM display_boards d
           JOIN branches b ON b.id = d.branch_id
           WHERE b.hospital_id = $1 ORDER BY d.name`,
          [hospitalId],
        ),
        this.db.query<TicketTemplateRow>(
          `SELECT id, name, paper, elements, instructions, footer, name_policy,
                  tracking_url
           FROM ticket_templates WHERE hospital_id = $1 ORDER BY name`,
          [hospitalId],
        ),
        this.db.query<SettingsRow>(
          `SELECT settings FROM hospital_settings WHERE hospital_id = $1`,
          [hospitalId],
        ),
      ]);

    const defaults = settings[0]?.settings ?? {};

    return {
      profile: {
        id: HospitalId(hospital.id),
        name: hospital.name,
        code: hospital.code,
        timezone: hospital.timezone,
        supportPhone: hospital.support_phone,
        brandColor: hospital.brand_color,
      },
      branches: branches.map((row) => ({
        id: BranchId(row.id),
        name: row.name,
        code: row.code,
        isDefault: row.is_default,
      })),
      stations: stations.map(toStationConfig),
      workflows: workflows.map((row) =>
        toWorkflow(
          row,
          stages.filter((stage) => stage.workflow_id === row.id),
        ),
      ) as readonly Workflow[],
      displayBoards: boards.map(
        (row): DisplayBoardConfig => ({
          id: row.id,
          name: row.name,
          stationIds: row.station_ids.map((id) => StationId(id)),
          waitingToShow: row.waiting_to_show,
          namePolicy: toNamePolicy(row.name_policy),
          showEstimatedWait: row.show_estimated_wait,
          showRoom: row.show_room,
        }),
      ),
      ticketTemplates: templates.map(
        (row): TicketTemplate => ({
          id: row.id,
          name: row.name,
          paper: row.paper as TicketTemplate["paper"],
          elements: row.elements,
          instructions: row.instructions,
          footer: row.footer,
          namePolicy: toNamePolicy(row.name_policy),
          trackingUrl: row.tracking_url,
        }),
      ),
      defaults: {
        namePolicy: toNamePolicy(defaults.namePolicy ?? "ticket_only"),
        ticketTemplateId: defaults.ticketTemplateId ?? templates[0]?.id ?? "",
      },
    };
  }
}

/**
 * Which branch a board belongs to, and which stations it shows.
 *
 * Separate from `DisplayBoardConfig`, which deliberately has no branch: a board
 * is configured as a set of stations, and which branch those sit in is a
 * property of the schema rather than of the configuration. The public board
 * endpoint needs the branch to scope its read, so it asks for it directly
 * instead of the domain type growing a field only one caller wants.
 */
export interface BoardLocation {
  readonly id: string;
  readonly branchId: string;
  readonly name: string;
  readonly stationIds: readonly string[];
}

export class PostgresBoardDirectory {
  constructor(private readonly db: Database) {}

  async find(boardId: string): Promise<BoardLocation | null> {
    const [row] = await this.db.query<DisplayBoardRow>(
      `SELECT id, branch_id, name, station_ids, waiting_to_show, name_policy,
              show_estimated_wait, show_room
       FROM display_boards WHERE id = $1`,
      [boardId],
    );
    if (row === undefined) return null;
    return {
      id: row.id,
      branchId: row.branch_id,
      name: row.name,
      stationIds: row.station_ids,
    };
  }
}

/** The workflow id helper, kept here so callers need not import the brand. */
export function workflowId(value: string): WorkflowId {
  return WorkflowId(value);
}
