import {
  DEFAULT_EVENT_PAGE_SIZE,
  type BranchId,
  type EventQuery,
  type EventRecord,
  type JourneyCode,
  type Session,
  type StationId,
  type UserId,
  type Visit,
  type VisitDependencies,
  type VisitId,
} from "@qman/domain";
import {
  fromEventRecord,
  fromSession,
  fromVisit,
  toEventRecord,
  toSession,
  toStoredAccount,
  toVisit,
  type StoredAccount,
} from "./mappers.js";
import type {
  EventRow,
  QueueEntryRow,
  SessionRow,
  UserRow,
  VisitRow,
} from "./rows.js";
import { WhereBuilder, type Database, type SqlExecutor } from "./sql.js";

/**
 * Repository ports.
 *
 * The application depends on these, never on SQL. That is what lets the current
 * in-memory stores and the Postgres implementations be swapped for one another
 * without a screen changing — and what will let the browser talk to an HTTP API
 * that implements the same shapes.
 */

export interface VisitRepository {
  find(id: VisitId): Promise<Visit | null>;
  findByJourneyCode(
    branchId: BranchId,
    code: JourneyCode,
  ): Promise<Visit | null>;
  /** Every visit with an open queue entry at a station. Drives worklists. */
  openAtStation(stationId: StationId): Promise<Visit[]>;
  /** Active visits for a branch, for dashboards and the reception list. */
  activeInBranch(branchId: BranchId): Promise<Visit[]>;
  /** Persists the visit and its queue entries, and appends its events. */
  save(visit: Visit, events: readonly NewEvent[]): Promise<void>;
  isJourneyCodeTaken(branchId: BranchId, code: JourneyCode): Promise<boolean>;
}

export type NewEvent = Omit<EventRecord, "id" | "sequence" | "recordedAt">;

export interface EventRepository {
  append(events: readonly NewEvent[]): Promise<void>;
  query(query: EventQuery): Promise<EventRecord[]>;
  forVisit(visitId: VisitId): Promise<EventRecord[]>;
}

export interface SessionRepository {
  find(id: string): Promise<Session | null>;
  /**
   * Resolves a presented token to its session.
   *
   * Takes the hash, never the token. The caller hashes what the browser sent
   * and looks that up, so the raw value exists only for the length of one
   * request and is never written anywhere it could be read back.
   */
  findByToken(tokenHash: string): Promise<Session | null>;
  /** Opens a session and binds it to a token. Separate from `save`, which updates one. */
  create(session: Session, tokenHash: string): Promise<void>;
  activeForHospital(): Promise<Session[]>;
  save(session: Session): Promise<void>;
  endAllForUser(userId: UserId, reason: string, at: Date): Promise<number>;
}

/**
 * Reads accounts for authentication.
 *
 * Scoped by hospital on every lookup, without exception. The tenant is a
 * parameter rather than something derived inside the query, so a caller cannot
 * omit it and quietly search every hospital at once — which is precisely the
 * mistake that turns a multi-tenant system into a shared one.
 */
export interface AccountRepository {
  findByUsername(hospitalId: string, username: string): Promise<StoredAccount | null>;
  findById(userId: UserId): Promise<StoredAccount | null>;
  updatePassword(
    userId: UserId,
    hash: string,
    salt: string,
    at: Date,
  ): Promise<void>;
}

/**
 * Allocates the next ticket ordinal for a station and period.
 *
 * The one operation that genuinely needs the database: two receptions admitting
 * patients at the same moment must not both be issued A-014.
 */
export interface TicketAllocator {
  next(stationId: StationId, periodKey: string): Promise<number>;
}

// ──────────────────────────────────────────────────────────── postgres

const VISIT_COLUMNS = `id, branch_id, workflow_id, journey_code, patient_name,
  hospital_number, phone, status, priority, current_queue_entry_id,
  created_at, completed_at, closed_at`;

const ENTRY_COLUMNS = `id, visit_id, station_id, queue_number, queue_label,
  queue_period, status, assigned_user_id, queued_at, called_at, started_at,
  completed_at, call_attempts, skipped, skip_reason, sequence`;

export class PostgresVisitRepository implements VisitRepository {
  constructor(
    private readonly db: Database,
    private readonly deps: VisitDependencies,
  ) {}

  async find(id: VisitId): Promise<Visit | null> {
    const [row] = await this.db.query<VisitRow>(
      `SELECT ${VISIT_COLUMNS} FROM visits WHERE id = $1`,
      [id],
    );
    if (!row) return null;
    return this.#hydrate([row]).then((visits) => visits[0] ?? null);
  }

  async findByJourneyCode(
    branchId: BranchId,
    code: JourneyCode,
  ): Promise<Visit | null> {
    const [row] = await this.db.query<VisitRow>(
      `SELECT ${VISIT_COLUMNS} FROM visits
       WHERE branch_id = $1 AND journey_code = $2 AND closed_at IS NULL`,
      [branchId, code],
    );
    if (!row) return null;
    return this.#hydrate([row]).then((visits) => visits[0] ?? null);
  }

  async openAtStation(stationId: StationId): Promise<Visit[]> {
    const rows = await this.db.query<VisitRow>(
      `SELECT DISTINCT ${VISIT_COLUMNS.split(",")
        .map((c) => `v.${c.trim()}`)
        .join(", ")}
       FROM visits v
       JOIN queue_entries q ON q.visit_id = v.id
       WHERE q.station_id = $1
         AND q.status IN ('waiting', 'called', 'in_progress')`,
      [stationId],
    );
    return this.#hydrate(rows);
  }

  async activeInBranch(branchId: BranchId): Promise<Visit[]> {
    const rows = await this.db.query<VisitRow>(
      `SELECT ${VISIT_COLUMNS} FROM visits
       WHERE branch_id = $1 AND closed_at IS NULL
       ORDER BY created_at DESC`,
      [branchId],
    );
    return this.#hydrate(rows);
  }

  async isJourneyCodeTaken(
    branchId: BranchId,
    code: JourneyCode,
  ): Promise<boolean> {
    const rows = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM visits
         WHERE branch_id = $1 AND journey_code = $2 AND closed_at IS NULL
       ) AS exists`,
      [branchId, code],
    );
    return rows[0]?.exists ?? false;
  }

  /**
   * Writes the visit, its queue entries and its events in one transaction.
   *
   * They land together or not at all. A queue entry without its visit is a
   * patient in a queue nobody can look up; an event without its state change is
   * a lie in the audit trail.
   */
  async save(visit: Visit, events: readonly NewEvent[]): Promise<void> {
    const { visit: row, entries } = fromVisit(visit);

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO visits (${VISIT_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           priority = EXCLUDED.priority,
           current_queue_entry_id = EXCLUDED.current_queue_entry_id,
           patient_name = EXCLUDED.patient_name,
           hospital_number = EXCLUDED.hospital_number,
           phone = EXCLUDED.phone,
           completed_at = EXCLUDED.completed_at,
           closed_at = EXCLUDED.closed_at`,
        [
          row.id,
          row.branch_id,
          row.workflow_id,
          row.journey_code,
          row.patient_name,
          row.hospital_number,
          row.phone,
          row.status,
          row.priority,
          row.current_queue_entry_id,
          row.created_at,
          row.completed_at,
          row.closed_at,
        ],
      );

      for (const entry of entries) {
        await tx.query(
          `INSERT INTO queue_entries (${ENTRY_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             assigned_user_id = EXCLUDED.assigned_user_id,
             called_at = EXCLUDED.called_at,
             started_at = EXCLUDED.started_at,
             completed_at = EXCLUDED.completed_at,
             call_attempts = EXCLUDED.call_attempts,
             skipped = EXCLUDED.skipped,
             skip_reason = EXCLUDED.skip_reason`,
          [
            entry.id,
            entry.visit_id,
            entry.station_id,
            entry.queue_number,
            entry.queue_label,
            entry.queue_period,
            entry.status,
            entry.assigned_user_id,
            entry.queued_at,
            entry.called_at,
            entry.started_at,
            entry.completed_at,
            entry.call_attempts,
            entry.skipped,
            entry.skip_reason,
            entry.sequence,
          ],
        );
      }

      if (events.length > 0) {
        await appendEvents(tx, events);
      }
    });
  }

  async #hydrate(rows: readonly VisitRow[]): Promise<Visit[]> {
    if (rows.length === 0) return [];

    // One query for every visit's entries rather than one per visit: a
    // reception list of forty visits is otherwise forty-one round trips.
    const entries = await this.db.query<QueueEntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM queue_entries
       WHERE visit_id = ANY($1) ORDER BY visit_id, sequence`,
      [rows.map((r) => r.id)],
    );

    const byVisit = new Map<string, QueueEntryRow[]>();
    for (const entry of entries) {
      const list = byVisit.get(entry.visit_id) ?? [];
      list.push(entry);
      byVisit.set(entry.visit_id, list);
    }

    return rows.map((row) =>
      toVisit(row, byVisit.get(row.id) ?? [], this.deps),
    );
  }
}

const EVENT_COLUMNS = `id, hospital_id, branch_id, sequence, category, type,
  visit_id, correlation_id, actor_id, occurred_at, recorded_at, payload, summary`;

async function appendEvents(
  tx: SqlExecutor,
  events: readonly NewEvent[],
): Promise<void> {
  for (const event of events) {
    const row = fromEventRecord(event);
    await tx.query(
      `INSERT INTO events
         (hospital_id, branch_id, category, type, visit_id, correlation_id,
          actor_id, occurred_at, payload, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        row.hospital_id,
        row.branch_id,
        row.category,
        row.type,
        row.visit_id,
        row.correlation_id,
        row.actor_id,
        row.occurred_at,
        JSON.stringify(row.payload),
        row.summary,
      ],
    );
  }
}

export class PostgresEventRepository implements EventRepository {
  constructor(private readonly db: Database) {}

  async append(events: readonly NewEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.db.transaction((tx) => appendEvents(tx, events));
  }

  /**
   * The Activity & Audit Explorer's one query.
   *
   * Filters mirror `matchesQuery` in the domain exactly, so the in-memory and
   * SQL paths cannot drift into answering the same question differently.
   */
  async query(query: EventQuery): Promise<EventRecord[]> {
    const where = new WhereBuilder();

    if (query.categories?.length) {
      where.add((p) => `category = ANY(${p})`, query.categories);
    }
    if (query.types?.length) {
      where.add((p) => `type = ANY(${p})`, query.types);
    }
    if (query.visitId) where.add((p) => `visit_id = ${p}`, query.visitId);
    if (query.correlationId) {
      // Upper-cased both sides: a Journey Code typed off a ticket arrives in
      // whatever case the user used.
      where.add(
        (p) => `upper(correlation_id) = upper(${p})`,
        query.correlationId,
      );
    }
    if (query.actorId) where.add((p) => `actor_id = ${p}`, query.actorId);
    if (query.branchId) where.add((p) => `branch_id = ${p}`, query.branchId);
    if (query.from) where.add((p) => `occurred_at >= ${p}`, query.from);
    if (query.to) where.add((p) => `occurred_at <= ${p}`, query.to);
    if (query.before !== undefined) {
      where.add((p) => `sequence < ${p}`, query.before);
    }
    if (query.search?.trim()) {
      // Matched against the rendered summary, which is what the search box
      // shows — searching the payload would find records the user cannot see.
      where.add(
        (p) =>
          `to_tsvector('simple', summary) @@ plainto_tsquery('simple', ${p})`,
        query.search.trim(),
      );
    }

    const clause = where.clause;
    const limit = where.next(
      Math.min(query.limit ?? DEFAULT_EVENT_PAGE_SIZE, 500),
    );

    const rows = await this.db.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM events${clause}
       ORDER BY sequence DESC LIMIT ${limit}`,
      where.params,
    );

    return rows.map(toEventRecord);
  }

  async forVisit(visitId: VisitId): Promise<EventRecord[]> {
    const rows = await this.db.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM events
       WHERE visit_id = $1 ORDER BY sequence ASC`,
      [visitId],
    );
    return rows.map(toEventRecord);
  }
}

const SESSION_COLUMNS = `id, user_id, branch_id, provider_id, device,
  user_agent, started_at, last_active_at, ended_at, end_reason`;

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly db: Database) {}

  async find(id: string): Promise<Session | null> {
    const [row] = await this.db.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1`,
      [id],
    );
    return row ? toSession(row) : null;
  }

  /**
   * Ended sessions are excluded in SQL rather than filtered afterwards.
   *
   * A signed-out session that still resolves is a signed-out session that still
   * works, and "the caller will check `endedAt`" is a rule that holds until one
   * caller forgets. The partial index on open sessions serves exactly this.
   */
  async findByToken(tokenHash: string): Promise<Session | null> {
    const [row] = await this.db.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE token_hash = $1 AND ended_at IS NULL`,
      [tokenHash],
    );
    return row ? toSession(row) : null;
  }

  async create(session: Session, tokenHash: string): Promise<void> {
    const row = fromSession(session);
    await this.db.query(
      `INSERT INTO sessions (${SESSION_COLUMNS}, token_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        row.id,
        row.user_id,
        row.branch_id,
        row.provider_id,
        row.device,
        row.user_agent,
        row.started_at,
        row.last_active_at,
        row.ended_at,
        row.end_reason,
        tokenHash,
      ],
    );
  }

  async activeForHospital(): Promise<Session[]> {
    const rows = await this.db.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE ended_at IS NULL ORDER BY last_active_at DESC`,
    );
    return rows.map(toSession);
  }

  async save(session: Session): Promise<void> {
    const row = fromSession(session);
    await this.db.query(
      `INSERT INTO sessions (${SESSION_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         last_active_at = EXCLUDED.last_active_at,
         ended_at = EXCLUDED.ended_at,
         end_reason = EXCLUDED.end_reason`,
      [
        row.id,
        row.user_id,
        row.branch_id,
        row.provider_id,
        row.device,
        row.user_agent,
        row.started_at,
        row.last_active_at,
        row.ended_at,
        row.end_reason,
      ],
    );
  }

  async endAllForUser(
    userId: UserId,
    reason: string,
    at: Date,
  ): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE sessions SET ended_at = $1, end_reason = $2
       WHERE user_id = $3 AND ended_at IS NULL
       RETURNING id`,
      [at, reason, userId],
    );
    return rows.length;
  }
}

const ACCOUNT_COLUMNS = `u.id, u.hospital_id, u.role_id, u.display_name,
  u.username, u.provider_id, u.password_hash, u.password_salt, u.enabled,
  r.key AS role_key, r.permissions,
  ARRAY(SELECT ub.branch_id::text FROM user_branches ub WHERE ub.user_id = u.id)
    AS branch_ids`;

/**
 * Joined, not looked up separately.
 *
 * Every authenticated request resolves an account to its permissions, so this
 * is the hottest read in the system. An inner join is also the correct
 * semantics: `role_id` is NOT NULL and RESTRICT-referenced, so a user without a
 * role cannot exist, and a query that tolerated one would be describing a state
 * the schema forbids.
 */
const ACCOUNT_FROM = `FROM users u JOIN roles r ON r.id = u.role_id`;

export class PostgresAccountRepository implements AccountRepository {
  constructor(private readonly db: Database) {}

  /**
   * Matched case-insensitively, against the same expression the unique index
   * uses. "Ifeoma" and "ifeoma" are one receptionist — and because the index
   * enforces that, this cannot return two rows for a name that differs only in
   * capitalisation.
   */
  async findByUsername(
    hospitalId: string,
    username: string,
  ): Promise<StoredAccount | null> {
    const [row] = await this.db.query<UserRow>(
      `SELECT ${ACCOUNT_COLUMNS} ${ACCOUNT_FROM}
       WHERE u.hospital_id = $1 AND lower(u.username) = lower($2)`,
      [hospitalId, username],
    );
    return row ? toStoredAccount(row) : null;
  }

  async findById(userId: UserId): Promise<StoredAccount | null> {
    const [row] = await this.db.query<UserRow>(
      `SELECT ${ACCOUNT_COLUMNS} ${ACCOUNT_FROM} WHERE u.id = $1`,
      [userId],
    );
    return row ? toStoredAccount(row) : null;
  }

  async updatePassword(
    userId: UserId,
    hash: string,
    salt: string,
    at: Date,
  ): Promise<void> {
    await this.db.query(
      `UPDATE users SET password_hash = $2, password_salt = $3, updated_at = $4
       WHERE id = $1`,
      [userId, hash, salt, at],
    );
  }
}

/**
 * Postgres ticket allocation.
 *
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` increments and reads under a
 * single row lock, so concurrent callers serialise on the row rather than
 * racing. A read-then-write would hand two receptions the same number.
 */
export class PostgresTicketAllocator implements TicketAllocator {
  constructor(private readonly db: SqlExecutor) {}

  async next(stationId: StationId, periodKey: string): Promise<number> {
    const rows = await this.db.query<{ last_value: number }>(
      `INSERT INTO queue_number_sequences (station_id, period_key, last_value)
       VALUES ($1, $2, 1)
       ON CONFLICT (station_id, period_key) DO UPDATE
         SET last_value = queue_number_sequences.last_value + 1
       RETURNING last_value`,
      [stationId, periodKey],
    );

    const value = rows[0]?.last_value;
    if (value === undefined) {
      throw new Error(
        `Ticket allocation returned no value for station ${stationId}`,
      );
    }
    return value;
  }

  /**
   * Advances a series so the next ticket is at least `atLeast`.
   *
   * `GREATEST` rather than assignment: recovery run twice, or run with a stale
   * figure, must never wind a series backwards. Winding back is precisely the
   * failure this exists to prevent.
   */
  async advanceTo(
    stationId: StationId,
    periodKey: string,
    atLeast: number,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO queue_number_sequences (station_id, period_key, last_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (station_id, period_key) DO UPDATE
         SET last_value = GREATEST(queue_number_sequences.last_value, $3)`,
      [stationId, periodKey, atLeast - 1],
    );
  }

  /**
   * Rebuilds every series from the tickets actually recorded.
   *
   * Run after a point-in-time restore. A restore rewinds the allocator but not
   * the waiting room: roll back to 13:55 after A-042 was printed at 13:58 and
   * the next patient is handed A-042 while the first is still holding theirs.
   *
   * **A ticket number, once issued to a patient, is never reissued.**
   *
   * This recovers what the database knows. Tickets written on paper during the
   * outage are known only to the staff who wrote them — see
   * `needsReconciliation` and the runbook.
   */
  async reconcileSeries(): Promise<
    Array<{ stationId: string; periodKey: string; resumeFrom: number }>
  > {
    const rows = await this.db.query<{
      station_id: string;
      queue_period: string;
      highest: number;
    }>(
      `INSERT INTO queue_number_sequences (station_id, period_key, last_value)
       SELECT station_id, queue_period, MAX(queue_number)
       FROM queue_entries
       GROUP BY station_id, queue_period
       ON CONFLICT (station_id, period_key) DO UPDATE
         SET last_value = GREATEST(
           queue_number_sequences.last_value,
           EXCLUDED.last_value
         )
       RETURNING station_id, period_key AS queue_period, last_value AS highest`,
    );

    return rows.map((row) => ({
      stationId: row.station_id,
      periodKey: row.queue_period,
      resumeFrom: row.highest + 1,
    }));
  }
}
