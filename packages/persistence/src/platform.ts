/**
 * Platform persistence.
 *
 * The storage QMan uses to administer itself: its own administrators, their
 * sessions, its audit log, and the directory of organizations it hosts.
 *
 * **Nothing in this file reads a hospital's data.**
 *
 * That is the property worth stating, because it is what keeps the two
 * administration layers separate at the layer where separation is easiest to
 * lose. A platform administrator can create an organization, suspend it and see
 * that it exists; there is no method here that returns a visit, a queue entry,
 * a patient, or a member of a hospital's staff. Reaching that data requires an
 * organization session, which a platform administrator does not have and cannot
 * mint for themselves.
 *
 * The organization directory is the one place the two touch, and it touches
 * only the `hospitals` row: id, code, name, status. Counts for the platform
 * list are aggregates — how many branches, how many staff — never the rows.
 */
import {
  isPlatformRole,
  type Organization,
  type OrganizationStatus,
  type PlatformRole,
} from "@qman/domain";
import type { Database } from "./sql.js";

// ────────────────────────────────────────────────────────── platform accounts

export interface StoredPlatformUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly passwordSalt: string;
  readonly role: PlatformRole;
  readonly enabled: boolean;
}

interface PlatformUserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  role: string;
  enabled: boolean;
}

/**
 * A role the application does not recognise resolves to no permissions.
 *
 * The database has a CHECK constraint holding the same closed set, so this is
 * the second of two locks. It matters if a future release removes a role that
 * rows still carry: those accounts lose their permissions rather than silently
 * keeping whatever the string used to mean.
 */
function toStoredPlatformUser(row: PlatformUserRow): StoredPlatformUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    role: isPlatformRole(row.role) ? row.role : ("unknown" as PlatformRole),
    enabled: row.enabled,
  };
}

export interface PlatformUserRepository {
  findByUsername(username: string): Promise<StoredPlatformUser | null>;
  findById(id: string): Promise<StoredPlatformUser | null>;
  /** How many exist. The bootstrap command's refusal is built on this. */
  count(): Promise<number>;
  create(user: Omit<StoredPlatformUser, "id">, at: Date): Promise<string>;
  updatePassword(id: string, hash: string, salt: string, at: Date): Promise<void>;
}

const PLATFORM_USER_COLUMNS = `id, username, display_name, password_hash, password_salt, role, enabled`;

export class PostgresPlatformUserRepository implements PlatformUserRepository {
  constructor(private readonly db: Database) {}

  /** Case-insensitive, against the same expression the unique index uses. */
  async findByUsername(username: string): Promise<StoredPlatformUser | null> {
    const [row] = await this.db.query<PlatformUserRow>(
      `SELECT ${PLATFORM_USER_COLUMNS} FROM platform_users WHERE lower(username) = lower($1)`,
      [username],
    );
    return row ? toStoredPlatformUser(row) : null;
  }

  async findById(id: string): Promise<StoredPlatformUser | null> {
    const [row] = await this.db.query<PlatformUserRow>(
      `SELECT ${PLATFORM_USER_COLUMNS} FROM platform_users WHERE id = $1`,
      [id],
    );
    return row ? toStoredPlatformUser(row) : null;
  }

  async count(): Promise<number> {
    const [row] = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform_users`,
    );
    return Number(row?.count ?? "0");
  }

  async create(user: Omit<StoredPlatformUser, "id">, at: Date): Promise<string> {
    const [row] = await this.db.query<{ id: string }>(
      `INSERT INTO platform_users
         (username, display_name, password_hash, password_salt, role, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING id`,
      [
        user.username,
        user.displayName,
        user.passwordHash,
        user.passwordSalt,
        user.role,
        user.enabled,
        at,
      ],
    );
    return row!.id;
  }

  async updatePassword(id: string, hash: string, salt: string, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE platform_users SET password_hash = $2, password_salt = $3, updated_at = $4
       WHERE id = $1`,
      [id, hash, salt, at],
    );
  }
}

// ────────────────────────────────────────────────────────── platform sessions

export interface PlatformSession {
  readonly id: string;
  readonly userId: string;
  readonly userAgent: string;
  readonly startedAt: Date;
  readonly lastActiveAt: Date;
  readonly endedAt: Date | null;
  readonly endReason: string | null;
}

interface PlatformSessionRow {
  id: string;
  user_id: string;
  user_agent: string;
  started_at: Date;
  last_active_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
}

function toPlatformSession(row: PlatformSessionRow): PlatformSession {
  return {
    id: row.id,
    userId: row.user_id,
    userAgent: row.user_agent,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
  };
}

export interface PlatformSessionRepository {
  /** Takes the hash, never the token. The raw value never reaches storage. */
  findByToken(tokenHash: string): Promise<PlatformSession | null>;
  create(session: Omit<PlatformSession, "id">, tokenHash: string): Promise<PlatformSession>;
  touch(id: string, at: Date): Promise<void>;
  end(id: string, reason: string, at: Date): Promise<void>;
  endAllForUser(userId: string, reason: string, at: Date): Promise<number>;
}

const PLATFORM_SESSION_COLUMNS = `id, user_id, user_agent, started_at, last_active_at, ended_at, end_reason`;

export class PostgresPlatformSessionRepository implements PlatformSessionRepository {
  constructor(private readonly db: Database) {}

  /**
   * Live sessions only.
   *
   * `ended_at IS NULL` is in the query rather than checked by the caller: a
   * signed-out token must not resolve, and a caller that forgot to check would
   * make sign-out advisory.
   */
  async findByToken(tokenHash: string): Promise<PlatformSession | null> {
    const [row] = await this.db.query<PlatformSessionRow>(
      `SELECT ${PLATFORM_SESSION_COLUMNS} FROM platform_sessions
       WHERE token_hash = $1 AND ended_at IS NULL`,
      [tokenHash],
    );
    return row ? toPlatformSession(row) : null;
  }

  async create(
    session: Omit<PlatformSession, "id">,
    tokenHash: string,
  ): Promise<PlatformSession> {
    const [row] = await this.db.query<PlatformSessionRow>(
      `INSERT INTO platform_sessions
         (user_id, token_hash, user_agent, started_at, last_active_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PLATFORM_SESSION_COLUMNS}`,
      [session.userId, tokenHash, session.userAgent, session.startedAt, session.lastActiveAt],
    );
    return toPlatformSession(row!);
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE platform_sessions SET last_active_at = $2 WHERE id = $1 AND ended_at IS NULL`,
      [id, at],
    );
  }

  async end(id: string, reason: string, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE platform_sessions SET ended_at = $3, end_reason = $2
       WHERE id = $1 AND ended_at IS NULL`,
      [id, reason, at],
    );
  }

  /** Used when a platform password is reset: every other session dies with it. */
  async endAllForUser(userId: string, reason: string, at: Date): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE platform_sessions SET ended_at = $3, end_reason = $2
       WHERE user_id = $1 AND ended_at IS NULL
       RETURNING id`,
      [userId, reason, at],
    );
    return rows.length;
  }
}

// ──────────────────────────────────────────────────────────── platform events

export interface NewPlatformEvent {
  readonly type: string;
  readonly actorId: string | null;
  readonly targetHospitalId: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
  readonly summary: string;
}

export interface PlatformEventRecord extends NewPlatformEvent {
  readonly id: string;
  readonly sequence: number;
}

interface PlatformEventRow {
  id: string;
  sequence: string;
  type: string;
  actor_id: string | null;
  target_hospital_id: string | null;
  correlation_id: string | null;
  occurred_at: Date;
  payload: Record<string, unknown>;
  summary: string;
}

function toPlatformEvent(row: PlatformEventRow): PlatformEventRecord {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    type: row.type,
    actorId: row.actor_id,
    targetHospitalId: row.target_hospital_id,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    payload: row.payload,
    summary: row.summary,
  };
}

export interface PlatformEventQuery {
  readonly targetHospitalId?: string;
  readonly limit?: number;
}

export interface PlatformEventRepository {
  append(event: NewPlatformEvent): Promise<void>;
  query(query?: PlatformEventQuery): Promise<PlatformEventRecord[]>;
}

const PLATFORM_EVENT_COLUMNS = `id, sequence, type, actor_id, target_hospital_id, correlation_id, occurred_at, payload, summary`;

export class PostgresPlatformEventRepository implements PlatformEventRepository {
  constructor(private readonly db: Database) {}

  async append(event: NewPlatformEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO platform_events
         (type, actor_id, target_hospital_id, correlation_id, occurred_at, payload, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.type,
        event.actorId,
        event.targetHospitalId,
        event.correlationId,
        event.occurredAt,
        JSON.stringify(event.payload),
        event.summary,
      ],
    );
  }

  async query(query: PlatformEventQuery = {}): Promise<PlatformEventRecord[]> {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 500);
    if (query.targetHospitalId !== undefined) {
      const rows = await this.db.query<PlatformEventRow>(
        `SELECT ${PLATFORM_EVENT_COLUMNS} FROM platform_events
         WHERE target_hospital_id = $1
         ORDER BY occurred_at DESC, sequence DESC
         LIMIT $2`,
        [query.targetHospitalId, limit],
      );
      return rows.map(toPlatformEvent);
    }
    const rows = await this.db.query<PlatformEventRow>(
      `SELECT ${PLATFORM_EVENT_COLUMNS} FROM platform_events
       ORDER BY occurred_at DESC, sequence DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map(toPlatformEvent);
  }
}

// ─────────────────────────────────────────────────────── organization directory

interface HospitalRow {
  id: string;
  code: string;
  name: string;
  status: string;
  timezone: string;
  suspended_at: Date | null;
  suspended_reason: string | null;
  created_at: Date;
}

function toOrganization(row: HospitalRow): Organization {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    // Anything the application does not recognise is treated as suspended.
    // The failure is one-directional on purpose: an unreadable status must
    // never resolve to "open for business".
    status: row.status === "active" ? "active" : "suspended",
    timezone: row.timezone,
    suspendedAt: row.suspended_at,
    suspendedReason: row.suspended_reason,
    createdAt: row.created_at,
  };
}

/** What the platform list shows about an organization, beyond its own row. */
export interface OrganizationSummary extends Organization {
  readonly branchCount: number;
  readonly userCount: number;
}

/**
 * The organization directory.
 *
 * Read by two very different callers, which is why `findByCode` and `findById`
 * both exist and both return the whole row.
 *
 * The login path uses `findByCode` to turn what a receptionist typed into the
 * immutable id that scopes everything afterwards. That is the only place a code
 * becomes an id, and after it the code is not consulted again.
 *
 * The platform portal uses the rest.
 */
export interface OrganizationDirectoryRepository {
  findById(id: string): Promise<Organization | null>;
  /** The login selector, resolved once per sign-in and never stored. */
  findByCode(code: string): Promise<Organization | null>;
  /**
   * The organization a branch belongs to.
   *
   * Used by the public surfaces, which are handed a board or a branch by an
   * unauthenticated caller and must decide whether the organization behind it
   * is still active. One indexed join rather than a status column copied onto
   * every branch, because a copy is a thing that can disagree.
   */
  findByBranch(branchId: string): Promise<Organization | null>;
  list(): Promise<OrganizationSummary[]>;
  setStatus(
    id: string,
    status: OrganizationStatus,
    reason: string | null,
    at: Date,
  ): Promise<void>;
  rename(id: string, name: string, code: string, at: Date): Promise<void>;
  /** Whether a code is taken, ignoring one organization's own row. */
  isCodeTaken(code: string, exceptId?: string): Promise<boolean>;
}

const HOSPITAL_COLUMNS = `id, code, name, status, timezone, suspended_at, suspended_reason, created_at`;

export class PostgresOrganizationDirectory implements OrganizationDirectoryRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<Organization | null> {
    const [row] = await this.db.query<HospitalRow>(
      `SELECT ${HOSPITAL_COLUMNS} FROM hospitals WHERE id = $1`,
      [id],
    );
    return row ? toOrganization(row) : null;
  }

  async findByCode(code: string): Promise<Organization | null> {
    const [row] = await this.db.query<HospitalRow>(
      `SELECT ${HOSPITAL_COLUMNS} FROM hospitals WHERE lower(code) = lower($1)`,
      [code],
    );
    return row ? toOrganization(row) : null;
  }

  async findByBranch(branchId: string): Promise<Organization | null> {
    const [row] = await this.db.query<HospitalRow>(
      `SELECT ${HOSPITAL_COLUMNS.split(", ").map((c) => `h.${c}`).join(", ")}
       FROM hospitals h
       JOIN branches b ON b.hospital_id = h.id
       WHERE b.id = $1`,
      [branchId],
    );
    return row ? toOrganization(row) : null;
  }

  /**
   * Counts are aggregates, never rows.
   *
   * The platform list says how many branches and staff an organization has. It
   * does not say who they are — that is the hospital's business, and a platform
   * screen that listed a hospital's staff would be the first crack in the
   * separation this layer exists to keep.
   */
  async list(): Promise<OrganizationSummary[]> {
    const rows = await this.db.query<HospitalRow & { branch_count: string; user_count: string }>(
      `SELECT ${HOSPITAL_COLUMNS.split(", ")
        .map((c) => `h.${c}`)
        .join(", ")},
              (SELECT count(*)::text FROM branches b WHERE b.hospital_id = h.id) AS branch_count,
              (SELECT count(*)::text FROM users u WHERE u.hospital_id = h.id)    AS user_count
       FROM hospitals h
       ORDER BY h.name ASC`,
    );
    return rows.map((row) => ({
      ...toOrganization(row),
      branchCount: Number(row.branch_count),
      userCount: Number(row.user_count),
    }));
  }

  async setStatus(
    id: string,
    status: OrganizationStatus,
    reason: string | null,
    at: Date,
  ): Promise<void> {
    await this.db.query(
      /*
       * The casts are load-bearing, not decoration.
       *
       * A bare `$4` inside `CASE WHEN … THEN $4 ELSE NULL END` gives PostgreSQL
       * nothing to infer a type from — both arms are unknown — so it settles on
       * text and the assignment to a timestamptz column fails. Suspension and
       * reactivation returned 500 for this reason and nothing caught it,
       * because every unit test used an in-memory directory and the inference
       * only happens in the server.
       */
      `UPDATE hospitals
       SET status = $2::text,
           suspended_at = CASE WHEN $2::text = 'suspended' THEN $4::timestamptz ELSE NULL END,
           suspended_reason = CASE WHEN $2::text = 'suspended' THEN $3::text ELSE NULL END,
           updated_at = $4::timestamptz
       WHERE id = $1`,
      [id, status, reason, at],
    );
  }

  /**
   * Both are editable, and neither is identity.
   *
   * Renaming an organization or changing its code touches one row and breaks
   * nothing, because every foreign key, scope check and audit record in the
   * system holds the id.
   */
  async rename(id: string, name: string, code: string, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE hospitals SET name = $2, code = $3, updated_at = $4 WHERE id = $1`,
      [id, name, code, at],
    );
  }

  async isCodeTaken(code: string, exceptId?: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM hospitals WHERE lower(code) = lower($1) AND ($2::uuid IS NULL OR id <> $2)`,
      [code, exceptId ?? null],
    );
    return rows.length > 0;
  }
}

// ────────────────────────────────────────────────────── platform login lockout

/**
 * Lockout counters for platform accounts.
 *
 * Keyed by username alone: there is no hospital to scope them to. Otherwise
 * identical to `PostgresLockoutRepository`, including that rows are written for
 * usernames that do not exist — recording only real accounts would make the
 * table itself an oracle for which platform logins are valid.
 *
 * The rolling window is not interpreted here. It is stored and returned as the
 * domain produced it, so there is one implementation of what counts as too many
 * failures rather than two that can disagree.
 */
export interface PlatformLockoutRepository {
  get(usernameKey: string): Promise<{ failures: Date[]; lockedUntil: Date | null }>;
  set(
    usernameKey: string,
    state: { failures: readonly Date[]; lockedUntil: Date | null },
    at: Date,
  ): Promise<void>;
  prune(before: Date): Promise<number>;
}

export class PostgresPlatformLockoutRepository implements PlatformLockoutRepository {
  constructor(private readonly db: Database) {}

  async get(usernameKey: string): Promise<{ failures: Date[]; lockedUntil: Date | null }> {
    const [row] = await this.db.query<{ failures: Date[]; locked_until: Date | null }>(
      `SELECT failures, locked_until FROM platform_login_throttle WHERE username_key = $1`,
      [usernameKey.toLowerCase()],
    );
    if (row === undefined) return { failures: [], lockedUntil: null };
    return { failures: row.failures, lockedUntil: row.locked_until };
  }

  async set(
    usernameKey: string,
    state: { failures: readonly Date[]; lockedUntil: Date | null },
    at: Date,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO platform_login_throttle (username_key, failures, locked_until, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username_key) DO UPDATE
         SET failures = EXCLUDED.failures,
             locked_until = EXCLUDED.locked_until,
             updated_at = EXCLUDED.updated_at`,
      [usernameKey.toLowerCase(), [...state.failures], state.lockedUntil, at],
    );
  }

  /** A row still holding a lock is kept, so pruning cannot clear an active one. */
  async prune(before: Date): Promise<number> {
    const rows = await this.db.query<{ username_key: string }>(
      `DELETE FROM platform_login_throttle
       WHERE updated_at < $1 AND (locked_until IS NULL OR locked_until < $1)
       RETURNING username_key`,
      [before],
    );
    return rows.length;
  }
}
