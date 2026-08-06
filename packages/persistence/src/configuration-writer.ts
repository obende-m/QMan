/**
 * Writing the hospital's configuration.
 *
 * Every method here persists one entity and nothing else. Deciding *whether* a
 * change is allowed is not this layer's work — that is
 * `validateHospitalConfiguration`, and it runs against the whole configuration
 * because most of the interesting rules are relationships between entities: a
 * workflow stage pointing at a disabled station, a board showing a station that
 * is not public, a default ticket template that no longer exists. A per-entity
 * check could not see any of them.
 *
 * So the shape is: load the whole configuration, apply the change, validate the
 * result, and only then write the one entity that moved. All four steps run
 * inside a single transaction, so a configuration that fails validation leaves
 * the database exactly as it was, and two administrators saving at once cannot
 * interleave a read with the other's write.
 */
import type {
  DisplayBoardConfig,
  RoleConfig,
  HospitalProfile,
  PatientNamePolicy,
  StationConfig,
  TicketTemplate,
  Workflow,
} from "@qman/domain";
import type { SqlExecutor } from "./sql.js";

/**
 * What still points at a configuration entity.
 *
 * Three foreign keys in the schema are `ON DELETE RESTRICT`: a queue entry to
 * its station, a visit to its workflow, a user to their role. Letting a delete
 * hit them would work — the database refuses and nothing is lost — but the
 * caller receives a constraint violation, which reaches an administrator as a
 * 500 and tells them nothing about what to do.
 *
 * So the references are counted first, and the refusal explains itself: this
 * station is in two workflows and has served forty patients, disable it
 * instead. That is the answer they needed, and it is only available before the
 * delete is attempted.
 */
export interface EntityUsage {
  /** Both forms, because English pluralisation rules produce "entrys". */
  readonly singular: string;
  readonly plural: string;
  readonly count: number;
}

export interface ConfigurationWriter {
  stationUsage(tx: SqlExecutor, hospitalId: string, stationId: string): Promise<EntityUsage[]>;
  workflowUsage(tx: SqlExecutor, hospitalId: string, workflowId: string): Promise<EntityUsage[]>;
  roleUsage(tx: SqlExecutor, hospitalId: string, roleId: string): Promise<EntityUsage[]>;

  createStation(
    tx: SqlExecutor,
    branchId: string,
    station: StationConfig,
    at: Date,
  ): Promise<void>;
  createWorkflow(tx: SqlExecutor, branchId: string, workflow: Workflow, at: Date): Promise<void>;
  createBoard(tx: SqlExecutor, branchId: string, board: DisplayBoardConfig, at: Date): Promise<void>;
  createTicketTemplate(
    tx: SqlExecutor,
    hospitalId: string,
    template: TicketTemplate,
    at: Date,
  ): Promise<void>;

  /*
   * The destructive three take the tenant, and it is not optional.
   *
   * A configuration change is applied to the caller's own configuration
   * document, so a foreign id filters out of it harmlessly — but `persist`
   * then called these with the raw id from the URL, and they deleted by id
   * alone. An administrator at one hospital could delete another hospital's
   * stations, workflows and boards. Scoping the DELETE itself means the id has
   * to belong to the caller for the statement to match anything.
   */
  deleteStation(tx: SqlExecutor, hospitalId: string, stationId: string): Promise<void>;
  deleteWorkflow(tx: SqlExecutor, hospitalId: string, workflowId: string): Promise<void>;
  deleteBoard(tx: SqlExecutor, hospitalId: string, boardId: string): Promise<void>;
  deleteTicketTemplate(tx: SqlExecutor, hospitalId: string, templateId: string): Promise<void>;

  createRole(tx: SqlExecutor, hospitalId: string, role: RoleConfig, at: Date): Promise<void>;
  updateRole(tx: SqlExecutor, hospitalId: string, role: RoleConfig, at: Date): Promise<void>;
  deleteRole(tx: SqlExecutor, hospitalId: string, roleId: string): Promise<void>;

  updateStation(tx: SqlExecutor, station: StationConfig, at: Date): Promise<void>;
  updateWorkflow(tx: SqlExecutor, workflow: Workflow, at: Date): Promise<void>;
  updateBoard(tx: SqlExecutor, board: DisplayBoardConfig, at: Date): Promise<void>;
  updateTicketTemplate(
    tx: SqlExecutor,
    hospitalId: string,
    template: TicketTemplate,
    at: Date,
  ): Promise<void>;
  updateProfile(tx: SqlExecutor, profile: HospitalProfile, at: Date): Promise<void>;
  updateDefaults(
    tx: SqlExecutor,
    hospitalId: string,
    defaults: { namePolicy: PatientNamePolicy; ticketTemplateId: string },
    at: Date,
  ): Promise<void>;
}

/** Counts that are zero are dropped, so a caller can report only what blocks. */
function blocking(counts: ReadonlyArray<EntityUsage>): EntityUsage[] {
  return counts.filter((usage) => usage.count > 0);
}

export class PostgresConfigurationWriter implements ConfigurationWriter {
  async stationUsage(
    tx: SqlExecutor,
    hospitalId: string,
    stationId: string,
  ): Promise<EntityUsage[]> {
    // Zero for a station that is not this hospital's, so the counts cannot be
    // used to probe another organization's size.
    const [row] = await tx.query<{ stages: string; entries: string; boards: string }>(
      `SELECT
         (SELECT count(*) FROM workflow_stages ws
            JOIN stations s ON s.id = ws.station_id
            JOIN branches b ON b.id = s.branch_id
           WHERE ws.station_id = $1 AND b.hospital_id = $2)::text AS stages,
         (SELECT count(*) FROM queue_entries q
            JOIN stations s ON s.id = q.station_id
            JOIN branches b ON b.id = s.branch_id
           WHERE q.station_id = $1 AND b.hospital_id = $2)::text AS entries,
         (SELECT count(*) FROM display_boards d
            JOIN branches b ON b.id = d.branch_id
           WHERE $1 = ANY(d.station_ids) AND b.hospital_id = $2)::text AS boards`,
      [stationId, hospitalId],
    );
    return blocking([
      { singular: "workflow stage", plural: "workflow stages", count: Number(row?.stages ?? 0) },
      { singular: "queue entry", plural: "queue entries", count: Number(row?.entries ?? 0) },
      { singular: "display board", plural: "display boards", count: Number(row?.boards ?? 0) },
    ]);
  }

  async workflowUsage(
    tx: SqlExecutor,
    hospitalId: string,
    workflowId: string,
  ): Promise<EntityUsage[]> {
    const [row] = await tx.query<{ visits: string }>(
      `SELECT (SELECT count(*) FROM visits v
                 JOIN branches b ON b.id = v.branch_id
                WHERE v.workflow_id = $1 AND b.hospital_id = $2)::text AS visits`,
      [workflowId, hospitalId],
    );
    return blocking([
      { singular: "visit", plural: "visits", count: Number(row?.visits ?? 0) },
    ]);
  }

  async roleUsage(
    tx: SqlExecutor,
    hospitalId: string,
    roleId: string,
  ): Promise<EntityUsage[]> {
    // Scoped like stationUsage and workflowUsage. Unscoped, this counted the
    // holders of any role id, so a refusal reading "3 users" confirmed another
    // organization's role was real and in use.
    const [row] = await tx.query<{ users: string }>(
      `SELECT (SELECT count(*) FROM users
                WHERE role_id = $1 AND hospital_id = $2)::text AS users`,
      [roleId, hospitalId],
    );
    return blocking([
      { singular: "user", plural: "users", count: Number(row?.users ?? 0) },
    ]);
  }

  async createStation(
    tx: SqlExecutor,
    branchId: string,
    station: StationConfig,
    at: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO stations
         (id, branch_id, name, code, room, staffing, service_estimate_ms,
          sla_target_wait_ms, sla_saturation_point, queue_template, queue_reset,
          queue_manual_epoch, is_public, enabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
      [
        station.id,
        branchId,
        station.name,
        station.code,
        station.room,
        station.staffing,
        station.serviceEstimateMillis,
        station.sla.targetWaitMillis,
        station.sla.saturationPoint,
        station.queueNumber.template,
        station.queueNumber.reset,
        station.queueNumber.manualEpoch ?? null,
        station.isPublic,
        station.enabled,
        at,
      ],
    );
  }

  async createWorkflow(
    tx: SqlExecutor,
    branchId: string,
    workflow: Workflow,
    at: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO workflows (id, branch_id, name, is_default, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [workflow.id, branchId, workflow.name, workflow.isDefault, at],
    );
    // Stages are written by the same routine the update path uses, so a
    // workflow created with stages and one edited into that shape land
    // identically.
    await this.#writeStages(tx, workflow);
  }

  async createBoard(
    tx: SqlExecutor,
    branchId: string,
    board: DisplayBoardConfig,
    at: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO display_boards
         (id, branch_id, name, station_ids, waiting_to_show, name_policy,
          show_estimated_wait, show_room, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [
        board.id,
        branchId,
        board.name,
        [...board.stationIds],
        board.waitingToShow,
        board.namePolicy,
        board.showEstimatedWait,
        board.showRoom,
        at,
      ],
    );
  }

  async createTicketTemplate(
    tx: SqlExecutor,
    hospitalId: string,
    template: TicketTemplate,
    at: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO ticket_templates
         (id, hospital_id, name, paper, elements, instructions, footer,
          name_policy, tracking_url, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [
        template.id,
        hospitalId,
        template.name,
        template.paper,
        JSON.stringify(template.elements),
        template.instructions,
        template.footer,
        template.namePolicy,
        template.trackingUrl,
        at,
      ],
    );
  }

  async deleteStation(
    tx: SqlExecutor,
    hospitalId: string,
    stationId: string,
  ): Promise<void> {
    await tx.query(
      `DELETE FROM stations s
        USING branches b
        WHERE s.id = $1 AND b.id = s.branch_id AND b.hospital_id = $2`,
      [stationId, hospitalId],
    );
  }

  async deleteWorkflow(
    tx: SqlExecutor,
    hospitalId: string,
    workflowId: string,
  ): Promise<void> {
    // Stages cascade with the workflow, which is correct: a stage has no
    // meaning apart from the workflow it belongs to.
    await tx.query(
      `DELETE FROM workflows w
        USING branches b
        WHERE w.id = $1 AND b.id = w.branch_id AND b.hospital_id = $2`,
      [workflowId, hospitalId],
    );
  }

  async deleteBoard(tx: SqlExecutor, hospitalId: string, boardId: string): Promise<void> {
    await tx.query(
      `DELETE FROM display_boards d
        USING branches b
        WHERE d.id = $1 AND b.id = d.branch_id AND b.hospital_id = $2`,
      [boardId, hospitalId],
    );
  }

  async deleteTicketTemplate(
    tx: SqlExecutor,
    hospitalId: string,
    templateId: string,
  ): Promise<void> {
    await tx.query(`DELETE FROM ticket_templates WHERE id = $1 AND hospital_id = $2`, [
      templateId,
      hospitalId,
    ]);
  }

  async createRole(
    tx: SqlExecutor,
    hospitalId: string,
    role: RoleConfig,
    at: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO roles
         (id, hospital_id, key, name, description, permissions, is_system,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [
        role.id,
        hospitalId,
        role.name.trim().toLowerCase().replace(/\s+/g, "_"),
        role.name,
        role.description,
        [...role.permissions],
        role.isSystem,
        at,
      ],
    );
  }

  /**
   * `is_system` is never written by an update.
   *
   * Built-in roles ship with QMan and exist so a hospital cannot delete every
   * administrative role and lock itself out. A role that could be edited into
   * or out of being a system role would defeat that.
   */
  async updateRole(
    tx: SqlExecutor,
    hospitalId: string,
    role: RoleConfig,
    at: Date,
  ): Promise<void> {
    await tx.query(
      `UPDATE roles SET name = $3, description = $4, permissions = $5, updated_at = $6
       WHERE id = $1 AND hospital_id = $2`,
      [role.id, hospitalId, role.name, role.description, [...role.permissions], at],
    );
  }

  async deleteRole(tx: SqlExecutor, hospitalId: string, roleId: string): Promise<void> {
    await tx.query(`DELETE FROM roles WHERE id = $1 AND hospital_id = $2 AND is_system = false`, [
      roleId,
      hospitalId,
    ]);
  }

  /**
   * Every method takes the transaction rather than holding a connection.
   *
   * The caller owns the unit of work, because the validation that decides
   * whether these writes may happen at all reads rows this cannot see.
   */
  async updateStation(tx: SqlExecutor, station: StationConfig, at: Date): Promise<void> {
    await tx.query(
      `UPDATE stations SET
         name = $2, code = $3, room = $4, staffing = $5,
         service_estimate_ms = $6, sla_target_wait_ms = $7,
         sla_saturation_point = $8, queue_template = $9, queue_reset = $10,
         queue_manual_epoch = $11, is_public = $12, enabled = $13, updated_at = $14
       WHERE id = $1`,
      [
        station.id,
        station.name,
        station.code,
        station.room,
        station.staffing,
        station.serviceEstimateMillis,
        station.sla.targetWaitMillis,
        station.sla.saturationPoint,
        station.queueNumber.template,
        station.queueNumber.reset,
        station.queueNumber.manualEpoch ?? null,
        station.isPublic,
        station.enabled,
        at,
      ],
    );
  }

  /**
   * Stages are replaced wholesale rather than merged.
   *
   * A workflow's stages are an ordered list, and order is the thing most often
   * edited. Reconciling insertions, deletions and moves against stored rows
   * would be a second implementation of a list the caller has already produced
   * correctly; deleting and re-inserting inside the transaction cannot leave a
   * stage that should have been removed.
   */
  async updateWorkflow(tx: SqlExecutor, workflow: Workflow, at: Date): Promise<void> {
    await tx.query(
      `UPDATE workflows SET name = $2, is_default = $3, updated_at = $4 WHERE id = $1`,
      [workflow.id, workflow.name, workflow.isDefault, at],
    );
    await tx.query(`DELETE FROM workflow_stages WHERE workflow_id = $1`, [workflow.id]);
    await this.#writeStages(tx, workflow);
  }

  async #writeStages(tx: SqlExecutor, workflow: Workflow): Promise<void> {
    for (const stage of workflow.stages) {
      await tx.query(
        `INSERT INTO workflow_stages
           (id, workflow_id, station_id, sequence, is_required,
            allow_skip, allow_repeat, branches_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          stage.id,
          workflow.id,
          stage.stationId,
          stage.sequence,
          stage.isRequired,
          stage.allowSkip,
          stage.allowRepeat,
          [...stage.branchesTo],
        ],
      );
    }
  }

  async updateBoard(tx: SqlExecutor, board: DisplayBoardConfig, at: Date): Promise<void> {
    await tx.query(
      `UPDATE display_boards SET
         name = $2, station_ids = $3, waiting_to_show = $4, name_policy = $5,
         show_estimated_wait = $6, show_room = $7, updated_at = $8
       WHERE id = $1`,
      [
        board.id,
        board.name,
        [...board.stationIds],
        board.waitingToShow,
        board.namePolicy,
        board.showEstimatedWait,
        board.showRoom,
        at,
      ],
    );
  }

  async updateTicketTemplate(
    tx: SqlExecutor,
    hospitalId: string,
    template: TicketTemplate,
    at: Date,
  ): Promise<void> {
    await tx.query(
      `UPDATE ticket_templates SET
         name = $3, paper = $4, elements = $5, instructions = $6, footer = $7,
         name_policy = $8, tracking_url = $9, updated_at = $10
       WHERE id = $1 AND hospital_id = $2`,
      [
        template.id,
        hospitalId,
        template.name,
        template.paper,
        JSON.stringify(template.elements),
        template.instructions,
        template.footer,
        template.namePolicy,
        template.trackingUrl,
        at,
      ],
    );
  }

  async updateProfile(tx: SqlExecutor, profile: HospitalProfile, at: Date): Promise<void> {
    await tx.query(
      `UPDATE hospitals SET
         name = $2, code = $3, timezone = $4, support_phone = $5,
         brand_color = $6, updated_at = $7
       WHERE id = $1`,
      [
        profile.id,
        profile.name,
        profile.code,
        profile.timezone,
        profile.supportPhone,
        profile.brandColor,
        at,
      ],
    );
  }

  /**
   * Upserted, because a hospital that has never changed a default has no row.
   * Reading one and inserting when absent would leave a window in which two
   * administrators both insert.
   */
  async updateDefaults(
    tx: SqlExecutor,
    hospitalId: string,
    defaults: { namePolicy: PatientNamePolicy; ticketTemplateId: string },
    at: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO hospital_settings (hospital_id, settings, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (hospital_id) DO UPDATE
         SET settings = EXCLUDED.settings, updated_at = EXCLUDED.updated_at`,
      [hospitalId, JSON.stringify(defaults), at],
    );
  }
}
