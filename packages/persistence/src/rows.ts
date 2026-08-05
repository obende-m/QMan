/**
 * Row shapes, exactly as the database returns them.
 *
 * Written out rather than inferred from a query builder so the mapping layer
 * has something concrete to be checked against, and so a schema change that
 * the mappers do not follow is a compile error rather than a runtime surprise
 * in a hospital.
 *
 * Naming is `snake_case` here and only here: this is the one layer that speaks
 * the database's language.
 */

export interface VisitRow {
  id: string;
  branch_id: string;
  workflow_id: string;
  journey_code: string;
  patient_name: string;
  hospital_number: string | null;
  phone: string | null;
  status: string;
  priority: string;
  current_queue_entry_id: string | null;
  created_at: Date;
  completed_at: Date | null;
  closed_at: Date | null;
}

export interface QueueEntryRow {
  id: string;
  visit_id: string;
  station_id: string;
  queue_number: number;
  queue_label: string;
  queue_period: string;
  status: string;
  assigned_user_id: string | null;
  queued_at: Date;
  called_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  call_attempts: number;
  skipped: boolean;
  skip_reason: string | null;
  sequence: number;
}

export interface EventRow {
  id: string;
  hospital_id: string;
  branch_id: string;
  sequence: string | number;
  category: string;
  type: string;
  visit_id: string | null;
  correlation_id: string | null;
  actor_id: string | null;
  occurred_at: Date;
  recorded_at: Date;
  payload: Record<string, unknown>;
  summary: string;
}

export interface StationRow {
  id: string;
  branch_id: string;
  name: string;
  code: string;
  room: string | null;
  staffing: number;
  service_estimate_ms: number;
  sla_target_wait_ms: number;
  sla_saturation_point: number;
  queue_template: string;
  queue_reset: string;
  queue_manual_epoch: string | null;
  is_public: boolean;
  enabled: boolean;
}

export interface WorkflowRow {
  id: string;
  branch_id: string;
  name: string;
  is_default: boolean;
}

export interface WorkflowStageRow {
  id: string;
  workflow_id: string;
  station_id: string;
  sequence: number;
  is_required: boolean;
  allow_skip: boolean;
  allow_repeat: boolean;
  branches_to: string[];
}

/**
 * A user with their branch grants, as the account lookup returns them.
 *
 * `branch_ids` is collected in the same statement rather than by a second
 * query. This is the lookup every sign-in performs, and an empty array is
 * meaningful — it means every branch, which is how a single-site hospital
 * avoids configuring something it does not have.
 */
export interface UserRow {
  id: string;
  hospital_id: string;
  role_id: string;
  display_name: string;
  username: string;
  provider_id: string;
  password_hash: string | null;
  password_salt: string | null;
  enabled: boolean;
  branch_ids: string[];
  role_key: string;
  /** The role's grant, resolved in the same statement. */
  permissions: string[];
}

export interface SessionRow {
  id: string;
  user_id: string;
  branch_id: string | null;
  provider_id: string;
  device: string;
  user_agent: string;
  started_at: Date;
  last_active_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
}

