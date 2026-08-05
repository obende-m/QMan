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
  HospitalProfile,
  PatientNamePolicy,
  StationConfig,
  TicketTemplate,
  Workflow,
} from "@qman/domain";
import type { SqlExecutor } from "./sql.js";

export interface ConfigurationWriter {
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

export class PostgresConfigurationWriter implements ConfigurationWriter {
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
