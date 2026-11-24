/**
 * Account, session and branch administration for one organization.
 *
 * Every statement here takes the organization as its first parameter and
 * applies it in SQL. A user id, a session id and a branch id all arrive from a
 * client in a URL; a method that trusted them alone could be pointed at
 * another organization's row, and would answer. The tenant is therefore not a
 * check a caller performs but a clause the statement cannot run without.
 *
 * Writes take the transaction they run in, so the change and its audit record
 * commit together or not at all. An account disabled without a record of who
 * disabled it is the one change an investigation most needs to explain.
 */
import type { Permission } from "@qman/domain";
import { ALL_PERMISSIONS } from "@qman/domain";
import type { Database, SqlExecutor } from "./sql.js";

export interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly branchIds: readonly string[];
  readonly enabled: boolean;
  readonly providerId: string;
  readonly passwordChangeRequired: boolean;
  readonly lastSignInAt: Date | null;
  readonly createdAt: Date;
  /** Whether the account is locked out by failed sign-ins right now. */
  readonly lockedUntil: Date | null;
}

export interface SessionSummary {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly username: string;
  readonly branchId: string | null;
  readonly device: string;
  readonly startedAt: Date;
  readonly lastActiveAt: Date;
}

export interface BranchSummary {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly isDefault: boolean;
}

export interface NewUser {
  readonly username: string;
  readonly displayName: string;
  readonly roleId: string;
  readonly branchIds: readonly string[];
  readonly passwordHash: string;
  readonly passwordSalt: string;
}

export interface UserChanges {
  readonly displayName?: string;
  readonly roleId?: string;
  readonly branchIds?: readonly string[];
  readonly enabled?: boolean;
}

interface UserListRow {
  id: string;
  username: string;
  display_name: string;
  role_id: string;
  role_name: string;
  branch_ids: string[];
  enabled: boolean;
  provider_id: string;
  password_change_required: boolean;
  last_sign_in_at: Date | null;
  created_at: Date;
  locked_until: Date | null;
}

const USER_SELECT = `
  SELECT u.id, u.username, u.display_name, u.role_id, r.name AS role_name,
         ARRAY(SELECT ub.branch_id::text FROM user_branches ub WHERE ub.user_id = u.id
               ORDER BY ub.branch_id) AS branch_ids,
         u.enabled, u.provider_id, u.password_change_required, u.last_sign_in_at,
         u.created_at,
         (SELECT t.locked_until FROM login_throttle t
           WHERE t.hospital_id = u.hospital_id AND t.username_key = lower(u.username)
             AND t.locked_until > now()) AS locked_until
  FROM users u JOIN roles r ON r.id = u.role_id`;

function toUser(row: UserListRow): UserSummary {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roleId: row.role_id,
    roleName: row.role_name,
    branchIds: row.branch_ids,
    enabled: row.enabled,
    providerId: row.provider_id,
    passwordChangeRequired: row.password_change_required,
    lastSignInAt: row.last_sign_in_at,
    createdAt: row.created_at,
    lockedUntil: row.locked_until,
  };
}

export interface AdministrationRepository {
  listUsers(hospitalId: string): Promise<UserSummary[]>;
  findUser(hospitalId: string, userId: string): Promise<UserSummary | null>;
  isUsernameTaken(hospitalId: string, username: string, exceptUserId?: string): Promise<boolean>;
  /** The role's permissions, or null when the role is not this organization's. */
  rolePermissions(hospitalId: string, roleId: string): Promise<Permission[] | null>;
  /** Whether every id names one of this organization's branches. */
  branchesBelong(hospitalId: string, branchIds: readonly string[]): Promise<boolean>;
  /** Enabled accounts able to manage users, optionally ignoring one. */
  countUserAdministrators(hospitalId: string, exceptUserId?: string): Promise<number>;

  createUser(tx: SqlExecutor, hospitalId: string, user: NewUser, at: Date): Promise<string>;
  /** Returns false when no row of this organization matched. */
  updateUser(tx: SqlExecutor, hospitalId: string, userId: string, changes: UserChanges, at: Date): Promise<boolean>;
  setPassword(
    tx: SqlExecutor,
    hospitalId: string,
    userId: string,
    hash: string,
    salt: string,
    changeRequired: boolean,
    at: Date,
  ): Promise<boolean>;
  clearLockout(tx: SqlExecutor, hospitalId: string, username: string): Promise<void>;
  recordSignIn(userId: string, at: Date): Promise<void>;
  passwordChangeRequired(userId: string): Promise<boolean>;

  listSessions(hospitalId: string): Promise<SessionSummary[]>;
  /** Ends one live session of this organization; returns its holder, or null. */
  endSession(tx: SqlExecutor, hospitalId: string, sessionId: string, reason: string, at: Date): Promise<string | null>;
  /** Ends a user's live sessions, optionally keeping one. Returns how many ended. */
  endSessionsForUser(
    tx: SqlExecutor,
    hospitalId: string,
    userId: string,
    reason: string,
    at: Date,
    keepSessionId?: string,
  ): Promise<number>;

  listBranches(hospitalId: string): Promise<BranchSummary[]>;
  isBranchCodeTaken(hospitalId: string, code: string, exceptBranchId?: string): Promise<boolean>;
  createBranch(tx: SqlExecutor, hospitalId: string, branch: { name: string; code: string }, at: Date): Promise<string>;
  updateBranch(
    tx: SqlExecutor,
    hospitalId: string,
    branchId: string,
    changes: { name?: string; code?: string; isDefault?: boolean },
  ): Promise<boolean>;
}

export class PostgresAdministrationRepository implements AdministrationRepository {
  constructor(private readonly db: Database) {}

  async listUsers(hospitalId: string): Promise<UserSummary[]> {
    const rows = await this.db.query<UserListRow>(
      `${USER_SELECT} WHERE u.hospital_id = $1 ORDER BY lower(u.display_name), u.id`,
      [hospitalId],
    );
    return rows.map(toUser);
  }

  async findUser(hospitalId: string, userId: string): Promise<UserSummary | null> {
    const [row] = await this.db.query<UserListRow>(
      `${USER_SELECT} WHERE u.hospital_id = $1 AND u.id = $2`,
      [hospitalId, userId],
    );
    return row ? toUser(row) : null;
  }

  async isUsernameTaken(hospitalId: string, username: string, exceptUserId?: string): Promise<boolean> {
    const rows = await this.db.query<{ taken: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM users
         WHERE hospital_id = $1 AND lower(username) = lower($2)
           AND ($3::uuid IS NULL OR id <> $3::uuid)
       ) AS taken`,
      [hospitalId, username, exceptUserId ?? null],
    );
    return rows[0]?.taken ?? false;
  }

  async rolePermissions(hospitalId: string, roleId: string): Promise<Permission[] | null> {
    const [row] = await this.db.query<{ permissions: string[] }>(
      `SELECT permissions FROM roles WHERE hospital_id = $1 AND id = $2`,
      [hospitalId, roleId],
    );
    if (!row) return null;
    const known: readonly string[] = ALL_PERMISSIONS;
    return row.permissions.filter((p): p is Permission => known.includes(p));
  }

  async branchesBelong(hospitalId: string, branchIds: readonly string[]): Promise<boolean> {
    if (branchIds.length === 0) return true;
    const [row] = await this.db.query<{ count: number | string }>(
      `SELECT count(*) AS count FROM branches WHERE hospital_id = $1 AND id = ANY($2::uuid[])`,
      [hospitalId, [...new Set(branchIds)]],
    );
    return Number(row?.count ?? 0) === new Set(branchIds).size;
  }

  async countUserAdministrators(hospitalId: string, exceptUserId?: string): Promise<number> {
    const [row] = await this.db.query<{ count: number | string }>(
      `SELECT count(*) AS count FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.hospital_id = $1 AND u.enabled
         AND 'admin.users' = ANY(r.permissions)
         AND ($2::uuid IS NULL OR u.id <> $2::uuid)`,
      [hospitalId, exceptUserId ?? null],
    );
    return Number(row?.count ?? 0);
  }

  async createUser(tx: SqlExecutor, hospitalId: string, user: NewUser, at: Date): Promise<string> {
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO users (hospital_id, role_id, display_name, username, provider_id,
                          password_hash, password_salt, enabled, password_change_required,
                          created_at, updated_at)
       SELECT $1, r.id, $3, $4, 'local', $5, $6, true, true, $7, $7
       FROM roles r WHERE r.id = $2 AND r.hospital_id = $1
       RETURNING id`,
      [hospitalId, user.roleId, user.displayName, user.username, user.passwordHash, user.passwordSalt, at],
    );
    if (!row) throw new Error("The role does not belong to this organization.");
    await this.#replaceBranches(tx, hospitalId, row.id, user.branchIds);
    return row.id;
  }

  async updateUser(
    tx: SqlExecutor,
    hospitalId: string,
    userId: string,
    changes: UserChanges,
    at: Date,
  ): Promise<boolean> {
    const updated = await tx.query<{ id: string }>(
      `UPDATE users u SET
         display_name = COALESCE($3, u.display_name),
         role_id = COALESCE(
           (SELECT r.id FROM roles r WHERE r.id = $4::uuid AND r.hospital_id = $1),
           u.role_id),
         enabled = COALESCE($5, u.enabled),
         updated_at = $6
       WHERE u.hospital_id = $1 AND u.id = $2
       RETURNING u.id`,
      [
        hospitalId,
        userId,
        changes.displayName ?? null,
        changes.roleId ?? null,
        changes.enabled ?? null,
        at,
      ],
    );
    if (updated.length === 0) return false;
    if (changes.branchIds !== undefined) {
      await this.#replaceBranches(tx, hospitalId, userId, changes.branchIds);
    }
    return true;
  }

  /** Only this organization's branches can be assigned, enforced in the INSERT itself. */
  async #replaceBranches(
    tx: SqlExecutor,
    hospitalId: string,
    userId: string,
    branchIds: readonly string[],
  ): Promise<void> {
    await tx.query(`DELETE FROM user_branches WHERE user_id = $1`, [userId]);
    if (branchIds.length === 0) return;
    await tx.query(
      `INSERT INTO user_branches (user_id, branch_id)
       SELECT $1, b.id FROM branches b
       WHERE b.hospital_id = $2 AND b.id = ANY($3::uuid[])`,
      [userId, hospitalId, [...new Set(branchIds)]],
    );
  }

  async setPassword(
    tx: SqlExecutor,
    hospitalId: string,
    userId: string,
    hash: string,
    salt: string,
    changeRequired: boolean,
    at: Date,
  ): Promise<boolean> {
    const rows = await tx.query<{ id: string }>(
      `UPDATE users SET password_hash = $3, password_salt = $4,
         password_change_required = $5, password_changed_at = $6, updated_at = $6
       WHERE hospital_id = $1 AND id = $2 AND provider_id = 'local'
       RETURNING id`,
      [hospitalId, userId, hash, salt, changeRequired, at],
    );
    return rows.length > 0;
  }

  async clearLockout(tx: SqlExecutor, hospitalId: string, username: string): Promise<void> {
    await tx.query(
      `DELETE FROM login_throttle WHERE hospital_id = $1 AND username_key = lower($2)`,
      [hospitalId, username],
    );
  }

  async recordSignIn(userId: string, at: Date): Promise<void> {
    await this.db.query(`UPDATE users SET last_sign_in_at = $2 WHERE id = $1`, [userId, at]);
  }

  async passwordChangeRequired(userId: string): Promise<boolean> {
    const [row] = await this.db.query<{ required: boolean }>(
      `SELECT password_change_required AS required FROM users WHERE id = $1`,
      [userId],
    );
    return row?.required ?? false;
  }

  async listSessions(hospitalId: string): Promise<SessionSummary[]> {
    const rows = await this.db.query<{
      id: string;
      user_id: string;
      display_name: string;
      username: string;
      branch_id: string | null;
      device: string;
      started_at: Date;
      last_active_at: Date;
    }>(
      `SELECT s.id, s.user_id, u.display_name, u.username, s.branch_id, s.device,
              s.started_at, s.last_active_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE u.hospital_id = $1 AND s.ended_at IS NULL
       ORDER BY s.last_active_at DESC
       LIMIT 500`,
      [hospitalId],
    );
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
      username: row.username,
      branchId: row.branch_id,
      device: row.device,
      startedAt: row.started_at,
      lastActiveAt: row.last_active_at,
    }));
  }

  async endSession(
    tx: SqlExecutor,
    hospitalId: string,
    sessionId: string,
    reason: string,
    at: Date,
  ): Promise<string | null> {
    const [row] = await tx.query<{ user_id: string }>(
      `UPDATE sessions s SET ended_at = $3, end_reason = $4
       FROM users u
       WHERE s.id = $2 AND u.id = s.user_id AND u.hospital_id = $1 AND s.ended_at IS NULL
       RETURNING s.user_id`,
      [hospitalId, sessionId, at, reason],
    );
    return row?.user_id ?? null;
  }

  async endSessionsForUser(
    tx: SqlExecutor,
    hospitalId: string,
    userId: string,
    reason: string,
    at: Date,
    keepSessionId?: string,
  ): Promise<number> {
    const rows = await tx.query<{ id: string }>(
      `UPDATE sessions s SET ended_at = $3, end_reason = $4
       FROM users u
       WHERE s.user_id = $2 AND u.id = s.user_id AND u.hospital_id = $1
         AND s.ended_at IS NULL AND ($5::uuid IS NULL OR s.id <> $5::uuid)
       RETURNING s.id`,
      [hospitalId, userId, at, reason, keepSessionId ?? null],
    );
    return rows.length;
  }

  async listBranches(hospitalId: string): Promise<BranchSummary[]> {
    const rows = await this.db.query<{ id: string; name: string; code: string; is_default: boolean }>(
      `SELECT id, name, code, is_default FROM branches WHERE hospital_id = $1
       ORDER BY is_default DESC, lower(name)`,
      [hospitalId],
    );
    return rows.map((row) => ({ id: row.id, name: row.name, code: row.code, isDefault: row.is_default }));
  }

  async isBranchCodeTaken(hospitalId: string, code: string, exceptBranchId?: string): Promise<boolean> {
    const rows = await this.db.query<{ taken: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM branches
         WHERE hospital_id = $1 AND lower(code) = lower($2)
           AND ($3::uuid IS NULL OR id <> $3::uuid)
       ) AS taken`,
      [hospitalId, code, exceptBranchId ?? null],
    );
    return rows[0]?.taken ?? false;
  }

  async createBranch(
    tx: SqlExecutor,
    hospitalId: string,
    branch: { name: string; code: string },
    at: Date,
  ): Promise<string> {
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO branches (hospital_id, name, code, is_default, created_at)
       VALUES ($1, $2, $3, false, $4) RETURNING id`,
      [hospitalId, branch.name, branch.code, at],
    );
    return row!.id;
  }

  /**
   * Making a branch the default clears the previous one first, in the same
   * transaction, because the unique index allows exactly one.
   */
  async updateBranch(
    tx: SqlExecutor,
    hospitalId: string,
    branchId: string,
    changes: { name?: string; code?: string; isDefault?: boolean },
  ): Promise<boolean> {
    if (changes.isDefault === true) {
      await tx.query(
        `UPDATE branches SET is_default = false WHERE hospital_id = $1 AND id <> $2 AND is_default`,
        [hospitalId, branchId],
      );
    }
    const rows = await tx.query<{ id: string }>(
      `UPDATE branches SET
         name = COALESCE($3, name),
         code = COALESCE($4, code),
         is_default = CASE WHEN $5::boolean IS TRUE THEN true ELSE is_default END
       WHERE hospital_id = $1 AND id = $2
       RETURNING id`,
      [hospitalId, branchId, changes.name ?? null, changes.code ?? null, changes.isDefault ?? null],
    );
    return rows.length > 0;
  }
}
