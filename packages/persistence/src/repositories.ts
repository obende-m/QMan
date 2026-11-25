import {
  DEFAULT_EVENT_PAGE_SIZE,
  NO_LOCKOUT,
  type BranchId,
  type EventQuery,
  type EventRecord,
  type JourneyCode,
  type LockoutState,
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

/**
 * Reads visits.
 *
 * **Every lookup takes the tenant, and it is the first argument.**
 *
 * Not a convention — a signature. A visit, a branch and a station are all
 * tenant-owned, and their identifiers are UUIDs that arrive from the client in
 * a URL. A method that accepted only the identifier could be called with
 * another organization's id and would answer, which is exactly the leak found
 * in the release audit: `GET /branches/:branchId/visits` returned whatever
 * branch it was handed.
 *
 * Making the tenant a required parameter moves that from something a route
 * author must remember to something the compiler refuses to let them omit, and
 * the filter lives in the SQL where it cannot be skipped by a caller at all.
 * `hospitalId` rather than `branchId` because a hospital may have many branches
 * and a user may work across them; the branch is a narrowing, not the boundary.
 */
export interface VisitRepository {
  find(hospitalId: string, id: VisitId): Promise<Visit | null>;
  findByJourneyCode(
    branchId: BranchId,
    code: JourneyCode,
  ): Promise<Visit | null>;
  /** Every visit with an open queue entry at a station. Drives worklists. */
  openAtStation(hospitalId: string, stationId: StationId): Promise<Visit[]>;
  /** Active visits for a branch, for dashboards and the reception list. */
  activeInBranch(hospitalId: string, branchId: BranchId): Promise<Visit[]>;
  /** Resolves the token printed into a ticket's QR code. Open visits only. */
  findByTrackingToken(tokenHash: string): Promise<Visit | null>;
  /**
   * Persists the visit and its queue entries, and appends its events.
   *
   * Optimistic: a visit this repository loaded is written only if nobody else
   * has written it since, and a visit it did not load is written only if it
   * does not exist yet. Either failure throws `ConcurrentModificationError`
   * and writes nothing — including the events, which describe a change that
   * did not happen.
   */
  save(
    visit: Visit,
    events: readonly NewEvent[],
    options?: { trackingTokenHash?: string },
  ): Promise<void>;
  isJourneyCodeTaken(branchId: BranchId, code: JourneyCode): Promise<boolean>;
  /**
   * Replaces an open visit's tracking token.
   *
   * Used when an admission is retried: the first response — and the only copy
   * of the first token — was lost, so a new token is minted and the old one
   * stops working. Returns false for a visit that is closed or not the
   * caller's.
   */
  reissueTrackingToken(hospitalId: string, id: VisitId, tokenHash: string): Promise<boolean>;
  /**
   * Open visits the closure job should look at, across every organization.
   *
   * The one deliberately unscoped read on this port, and named for the job
   * that uses it. It returns each visit with its owner so the job records the
   * closure under the right tenant; no route may call it.
   */
  awaitingClosure(criteria: ClosureCriteria): Promise<Array<{ hospitalId: string; visit: Visit }>>;
}

export interface ClosureCriteria {
  /** Completed or cancelled before this instant: sealed. */
  readonly finishedBefore: Date;
  /** Admitted before this instant and still not finished: abandoned. */
  readonly admittedBefore: Date;
  readonly limit: number;
}

/**
 * A visit changed between being read and being written.
 *
 * Expected under load rather than exceptional: two stations pressing a button
 * for the same patient in the same second. The caller's view is stale, and the
 * honest answer is a 409 telling them to look again.
 */
export class ConcurrentModificationError extends Error {
  readonly code = "VISIT_CHANGED";
  constructor(readonly visitId: string) {
    super("This visit was changed by someone else a moment ago.");
    this.name = "ConcurrentModificationError";
  }
}

export type NewEvent = Omit<EventRecord, "id" | "sequence" | "recordedAt">;

/**
 * Reads the business event log.
 *
 * Tenant-scoped for the same reason `VisitRepository` is, and more urgently:
 * an event's `summary` is rendered prose containing Journey Codes and, for
 * administrative records, what was changed. An unscoped query returned every
 * organization's history — the release audit found `GET /api/v1/events` doing
 * exactly that whenever no branch filter was supplied.
 *
 * The hospital is a separate required parameter rather than a field on
 * `EventQuery`, because a field is optional-looking and a caller who omitted it
 * would get everything. A parameter cannot be omitted.
 */
export interface EventRepository {
  append(events: readonly NewEvent[]): Promise<void>;
  query(hospitalId: string, query: EventQuery): Promise<EventRecord[]>;
  forVisit(hospitalId: string, visitId: VisitId): Promise<EventRecord[]>;
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

/** What every visit read selects: the columns plus the version it was read at. */
function selectVisit(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `${VISIT_COLUMNS.split(",")
    .map((c) => `${prefix}${c.trim()}`)
    .join(", ")}, ${prefix}version`;
}

export class PostgresVisitRepository implements VisitRepository {
  /**
   * The version each loaded visit was read at.
   *
   * Kept beside the aggregate rather than on it, because a version is a fact
   * about storage and the domain has no use for it. Weak, so a visit the
   * request has finished with is collected with its entry.
   */
  readonly #versions = new WeakMap<Visit, number>();

  constructor(
    private readonly db: Database,
    private readonly deps: VisitDependencies,
  ) {}

  /**
   * The tenant is joined through, not trusted from the caller.
   *
   * `visits` carries a branch, and a branch carries a hospital, so ownership is
   * one join away and is applied inside the query. A visit belonging to another
   * organization returns no row — indistinguishable from one that does not
   * exist, which is what a caller probing identifiers should see.
   */
  async find(hospitalId: string, id: VisitId): Promise<Visit | null> {
    const [row] = await this.db.query<VisitRow>(
      `SELECT ${selectVisit("v")}
       FROM visits v
       JOIN branches b ON b.id = v.branch_id
       WHERE v.id = $1 AND b.hospital_id = $2`,
      [id, hospitalId],
    );
    if (!row) return null;
    return this.#hydrate([row]).then((visits) => visits[0] ?? null);
  }

  async findByJourneyCode(
    branchId: BranchId,
    code: JourneyCode,
  ): Promise<Visit | null> {
    const [row] = await this.db.query<VisitRow>(
      `SELECT ${selectVisit()} FROM visits
       WHERE branch_id = $1 AND journey_code = $2 AND closed_at IS NULL`,
      [branchId, code],
    );
    if (!row) return null;
    return this.#hydrate([row]).then((visits) => visits[0] ?? null);
  }

  async openAtStation(hospitalId: string, stationId: StationId): Promise<Visit[]> {
    const rows = await this.db.query<VisitRow>(
      `SELECT DISTINCT ${selectVisit("v")}
       FROM visits v
       JOIN queue_entries q ON q.visit_id = v.id
       JOIN branches b ON b.id = v.branch_id
       WHERE q.station_id = $1
         AND b.hospital_id = $2
         AND q.status IN ('waiting', 'called', 'in_progress')`,
      [stationId, hospitalId],
    );
    return this.#hydrate(rows);
  }

  async activeInBranch(hospitalId: string, branchId: BranchId): Promise<Visit[]> {
    const rows = await this.db.query<VisitRow>(
      `SELECT ${selectVisit("v")}
       FROM visits v
       JOIN branches b ON b.id = v.branch_id
       WHERE v.branch_id = $1 AND b.hospital_id = $2 AND v.closed_at IS NULL
       ORDER BY v.created_at DESC`,
      [branchId, hospitalId],
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
   * Looks up a visit by the hash of its tracking token.
   *
   * Open visits only. A token for a closed visit resolving would leave a
   * working link on a ticket in someone's pocket long after the visit ended.
   */
  async findByTrackingToken(tokenHash: string): Promise<Visit | null> {
    const [row] = await this.db.query<VisitRow>(
      `SELECT ${selectVisit()} FROM visits
       WHERE tracking_token_hash = $1 AND closed_at IS NULL`,
      [tokenHash],
    );
    if (!row) return null;
    return this.#hydrate([row]).then((visits) => visits[0] ?? null);
  }

  /**
   * Writes the visit, its queue entries and its events in one transaction.
   *
   * They land together or not at all. A queue entry without its visit is a
   * patient in a queue nobody can look up; an event without its state change is
   * a lie in the audit trail.
   *
   * **The visit row is written first, and conditionally.** An update states the
   * version this repository read; an insert refuses an id that already exists.
   * Whichever applies, a lost race matches no row, the transaction is abandoned
   * before a queue entry or an event is touched, and the caller is told. The
   * UPDATE takes the row lock, so a concurrent writer waits for this one and
   * then finds the version it read is gone — the second click loses, visibly,
   * instead of erasing the first.
   */
  async save(
    visit: Visit,
    events: readonly NewEvent[],
    options: { trackingTokenHash?: string } = {},
  ): Promise<void> {
    const { visit: row, entries } = fromVisit(visit);
    const known = this.#versions.get(visit);

    const written = await this.db.transaction(async (tx) => {
      let version: number;
      if (known === undefined) {
        const inserted = await tx.query<{ version: number }>(
          `INSERT INTO visits (${VISIT_COLUMNS}, tracking_token_hash, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0)
           ON CONFLICT (id) DO NOTHING
           RETURNING version`,
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
            options.trackingTokenHash ?? null,
          ],
        );
        if (inserted.length === 0) throw new ConcurrentModificationError(row.id);
        version = inserted[0]!.version;
      } else {
        // Immutable facts — branch, workflow, Journey Code, admission time — are
        // not in the SET list, so a later save cannot rewrite them.
        const updated = await tx.query<{ version: number }>(
          `UPDATE visits SET
             -- COALESCE, so a save that carries no token does not clear the one
             -- issued at admission and printed on the patient's ticket.
             tracking_token_hash = COALESCE($2, tracking_token_hash),
             status = $3,
             priority = $4,
             current_queue_entry_id = $5,
             patient_name = $6,
             hospital_number = $7,
             phone = $8,
             completed_at = $9,
             closed_at = $10,
             version = version + 1
           WHERE id = $1 AND version = $11
           RETURNING version`,
          [
            row.id,
            options.trackingTokenHash ?? null,
            row.status,
            row.priority,
            row.current_queue_entry_id,
            row.patient_name,
            row.hospital_number,
            row.phone,
            row.completed_at,
            row.closed_at,
            known,
          ],
        );
        if (updated.length === 0) throw new ConcurrentModificationError(row.id);
        version = updated[0]!.version;
      }

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
      return version;
    });

    this.#versions.set(visit, written);
  }

  async reissueTrackingToken(
    hospitalId: string,
    id: VisitId,
    tokenHash: string,
  ): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE visits v SET tracking_token_hash = $3
       FROM branches b
       WHERE v.id = $1 AND b.id = v.branch_id AND b.hospital_id = $2
         AND v.closed_at IS NULL
       RETURNING v.id`,
      [id, hospitalId, tokenHash],
    );
    return rows.length > 0;
  }

  /**
   * Finished visits past their grace period, and unfinished ones past the
   * operating day, oldest first and bounded so one run cannot hold a long
   * transaction over the whole table.
   */
  async awaitingClosure(
    criteria: ClosureCriteria,
  ): Promise<Array<{ hospitalId: string; visit: Visit }>> {
    const rows = await this.db.query<VisitRow & { owner_hospital_id: string }>(
      `SELECT ${selectVisit("v")}, b.hospital_id AS owner_hospital_id
       FROM visits v
       JOIN branches b ON b.id = v.branch_id
       WHERE v.closed_at IS NULL
         AND (
           (v.status IN ('completed', 'cancelled')
              AND COALESCE(v.completed_at, v.created_at) < $1)
           OR (v.status NOT IN ('completed', 'cancelled') AND v.created_at < $2)
         )
       ORDER BY v.created_at
       LIMIT $3`,
      [criteria.finishedBefore, criteria.admittedBefore, criteria.limit],
    );
    const visits = await this.#hydrate(rows);
    return visits.map((visit, index) => ({
      hospitalId: rows[index]!.owner_hospital_id,
      visit,
    }));
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

    return rows.map((row) => {
      const visit = toVisit(row, byVisit.get(row.id) ?? [], this.deps);
      this.#versions.set(visit, typeof row.version === "number" ? row.version : 0);
      return visit;
    });
  }
}

const EVENT_COLUMNS = `id, hospital_id, branch_id, sequence, category, type,
  visit_id, correlation_id, actor_id, occurred_at, recorded_at, payload, summary`;

export async function appendEvents(
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
  async query(hospitalId: string, query: EventQuery): Promise<EventRecord[]> {
    const where = new WhereBuilder();

    // First, and unconditional. Every other clause narrows within it.
    where.add((p) => `hospital_id = ${p}`, hospitalId);

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

  async forVisit(hospitalId: string, visitId: VisitId): Promise<EventRecord[]> {
    const rows = await this.db.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM events
       WHERE visit_id = $1 AND hospital_id = $2 ORDER BY sequence ASC`,
      [visitId, hospitalId],
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
  u.password_change_required,
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
 * Lockout counters, durable across restarts and shared between instances.
 *
 * Read and written on the sign-in path, so both operations are single
 * statements. The state itself is the domain's — this stores and returns it
 * without interpreting the rolling window, which stays one implementation in
 * `@qman/domain` rather than two that can disagree.
 */
export interface LockoutRepository {
  get(hospitalId: string, usernameKey: string): Promise<LockoutState>;
  set(
    hospitalId: string,
    usernameKey: string,
    state: LockoutState,
    at: Date,
  ): Promise<void>;
  /** Discards counters last touched before the given time. */
  prune(before: Date): Promise<number>;
}

interface LoginThrottleRow {
  failures: Date[];
  locked_until: Date | null;
}

export class PostgresLockoutRepository implements LockoutRepository {
  constructor(private readonly db: Database) {}

  async get(hospitalId: string, usernameKey: string): Promise<LockoutState> {
    const [row] = await this.db.query<LoginThrottleRow>(
      `SELECT failures, locked_until FROM login_throttle
       WHERE hospital_id = $1 AND username_key = $2`,
      [hospitalId, usernameKey.toLowerCase()],
    );
    if (row === undefined) return NO_LOCKOUT;
    return { failures: row.failures, lockedUntil: row.locked_until };
  }

  async set(
    hospitalId: string,
    usernameKey: string,
    state: LockoutState,
    at: Date,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO login_throttle
         (hospital_id, username_key, failures, locked_until, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (hospital_id, username_key) DO UPDATE
         SET failures = EXCLUDED.failures,
             locked_until = EXCLUDED.locked_until,
             updated_at = EXCLUDED.updated_at`,
      [hospitalId, usernameKey.toLowerCase(), [...state.failures], state.lockedUntil, at],
    );
  }

  /**
   * A row still holding a lock is kept even if it is stale, so pruning cannot
   * be used to clear an active lockout by waiting for maintenance to run.
   */
  async prune(before: Date): Promise<number> {
    const rows = await this.db.query<{ hospital_id: string }>(
      `DELETE FROM login_throttle
       WHERE updated_at < $1 AND (locked_until IS NULL OR locked_until < $1)
       RETURNING hospital_id`,
      [before],
    );
    return rows.length;
  }
}

/**
 * Stored results of state-changing requests, keyed by the client's key.
 *
 * The claim is what makes this safe under concurrency. Two retries arriving
 * together must not both do the work, so the key is claimed with an insert that
 * either succeeds or reports that someone else holds it — never a read followed
 * by a write, which has a window between the two exactly wide enough for the
 * race this exists to prevent.
 */
export type IdempotencyClaim =
  | { readonly outcome: "claimed" }
  | { readonly outcome: "in_flight" }
  | { readonly outcome: "mismatch" }
  | {
      readonly outcome: "replay";
      readonly statusCode: number;
      readonly response: unknown;
    };

export interface IdempotencyRepository {
  claim(
    hospitalId: string,
    key: string,
    fingerprint: string,
    at: Date,
  ): Promise<IdempotencyClaim>;
  complete(
    hospitalId: string,
    key: string,
    statusCode: number,
    response: unknown,
    at: Date,
  ): Promise<void>;
  /** Releases a claim whose request failed, so a retry may do the work. */
  release(hospitalId: string, key: string): Promise<void>;
  prune(before: Date): Promise<number>;
}

interface IdempotencyRow {
  fingerprint: string;
  status_code: number | null;
  response: unknown;
}

export class PostgresIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly db: Database) {}

  async claim(
    hospitalId: string,
    key: string,
    fingerprint: string,
    at: Date,
  ): Promise<IdempotencyClaim> {
    // DO NOTHING rather than DO UPDATE: losing the race must not overwrite the
    // winner's row, and the empty result is precisely the signal that someone
    // else got there first.
    const inserted = await this.db.query<{ key: string }>(
      `INSERT INTO idempotency_keys (hospital_id, key, fingerprint, claimed_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (hospital_id, key) DO NOTHING
       RETURNING key`,
      [hospitalId, key, fingerprint, at],
    );
    if (inserted.length > 0) return { outcome: "claimed" };

    const [existing] = await this.db.query<IdempotencyRow>(
      `SELECT fingerprint, status_code, response FROM idempotency_keys
       WHERE hospital_id = $1 AND key = $2`,
      [hospitalId, key],
    );

    // Vanished between the insert and the read — pruned, or released by a
    // failure. Treating it as in flight makes the client retry, which is the
    // safe reading of an ambiguous state.
    if (existing === undefined) return { outcome: "in_flight" };

    if (existing.fingerprint !== fingerprint) return { outcome: "mismatch" };
    if (existing.status_code === null) return { outcome: "in_flight" };

    return {
      outcome: "replay",
      statusCode: existing.status_code,
      response: existing.response,
    };
  }

  async complete(
    hospitalId: string,
    key: string,
    statusCode: number,
    response: unknown,
    at: Date,
  ): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_keys
         SET status_code = $3, response = $4, completed_at = $5
       WHERE hospital_id = $1 AND key = $2`,
      [hospitalId, key, statusCode, JSON.stringify(response), at],
    );
  }

  /**
   * Only an unfinished claim is released. A completed one is the stored answer
   * and deleting it would let the work run twice.
   */
  async release(hospitalId: string, key: string): Promise<void> {
    await this.db.query(
      `DELETE FROM idempotency_keys
       WHERE hospital_id = $1 AND key = $2 AND status_code IS NULL`,
      [hospitalId, key],
    );
  }

  async prune(before: Date): Promise<number> {
    const rows = await this.db.query<{ key: string }>(
      `DELETE FROM idempotency_keys WHERE claimed_at < $1 RETURNING key`,
      [before],
    );
    return rows.length;
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
