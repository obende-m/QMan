import { beforeEach, describe, expect, it } from "vitest";
import {
  BranchId,
  FixedClock,
  StationId,
  UserId,
  Visit,
  VisitId,
  WorkflowId,
  parseJourneyCode,
  type IdGenerator,
} from "@qman/domain";
import {
  PostgresEventRepository,
  PostgresSessionRepository,
  PostgresTicketAllocator,
  PostgresVisitRepository,
  ConcurrentModificationError,
} from "./repositories.js";
import { FakeDatabase } from "./sql.js";

class Ids implements IdGenerator {
  #n = 0;
  next(): string {
    this.#n += 1;
    return `id-${this.#n}`;
  }
}

/** The tenant every scoped repository read now requires. */
const HOSPITAL = "hospital-1";
const BRANCH = BranchId("branch-1");
const CONSULT = StationId("st-consultation");
const LAB = StationId("st-laboratory");

function newVisit() {
  const deps = { clock: new FixedClock(), ids: new Ids() };
  const visit = Visit.create(
    {
      journeyCode: parseJourneyCode("QM-8F4K"),
      branchId: BRANCH,
      workflowId: WorkflowId("wf-1"),
      patient: { name: "Amara Okafor", hospitalNumber: "HN-1", phone: null },
    },
    deps,
  );
  visit.enqueue(CONSULT, { ordinal: 23, label: "A-023", periodKey: "2026-03-09" });
  return { visit, deps };
}

describe("visit repository", () => {
  let db: FakeDatabase;

  beforeEach(() => {
    db = new FakeDatabase();
  });

  /**
   * The visit row, its queue entries and its events must land together. A queue
   * entry without its visit is a patient nobody can look up; an event without
   * its state change is a lie in the audit trail.
   */
  it("writes visit, entries and events in one transaction", async () => {
    const { visit, deps } = newVisit();
    const events = visit.pullEvents();
    const repo = new PostgresVisitRepository(db, deps);
    db.willReturn([{ version: 0 }]);

    await repo.save(
      visit,
      events.map((e) => ({
        hospitalId: "hosp-1" as never,
        branchId: BRANCH,
        category: "operational" as const,
        type: e.type,
        visitId: e.visitId,
        correlationId: e.journeyCode,
        actorId: e.actorId,
        occurredAt: e.occurredAt,
        payload: e.payload as Record<string, unknown>,
        summary: e.type,
      })),
    );

    expect(db.matching("insert into visits")).toHaveLength(1);
    expect(db.matching("insert into queue_entries")).toHaveLength(1);
    expect(db.matching("insert into events")).toHaveLength(2);
    // A single commit covering everything written.
    expect(db.committed).toEqual([db.statements.length]);
  });

  it("inserts a new visit only if its id is not already taken", async () => {
    const { visit, deps } = newVisit();
    visit.pullEvents();
    db.willReturn([{ version: 0 }]);
    await new PostgresVisitRepository(db, deps).save(visit, []);

    const sql = db.matching("insert into visits")[0]!.sql.toLowerCase();
    expect(sql).toContain("on conflict (id) do nothing");
    expect(sql).not.toContain("do update");
  });

  it("updates a visit it has saved only at the version it holds", async () => {
    const { visit, deps } = newVisit();
    visit.pullEvents();
    const repo = new PostgresVisitRepository(db, deps);
    db.willReturn([{ version: 0 }]);
    await repo.save(visit, []);

    db.reset();
    db.willReturn([{ version: 1 }]);
    visit.call(UserId("user-1"));
    await repo.save(visit, []);

    const update = db.matching("update visits")[0]!;
    expect(update.sql.toLowerCase()).toContain("where id = $1 and version = $11");
    expect(update.sql.toLowerCase()).toContain("version = version + 1");
    // Immutable facts must not be overwritten by a later save.
    expect(update.sql.toLowerCase()).not.toContain("created_at =");
    expect(update.sql.toLowerCase()).not.toContain("journey_code =");
    expect(update.params[10]).toBe(0);

    // The next save states the version the last one produced.
    db.reset();
    db.willReturn([{ version: 2 }]);
    await repo.save(visit, []);
    expect(db.matching("update visits")[0]!.params[10]).toBe(1);
  });

  it("refuses a stale write and writes nothing after it", async () => {
    const { visit, deps } = newVisit();
    visit.pullEvents();
    const repo = new PostgresVisitRepository(db, deps);
    db.willReturn([{ version: 0 }]);
    await repo.save(visit, []);

    db.reset();
    // The conditional UPDATE matches no row: someone else wrote first.
    db.willReturn([]);
    visit.call(UserId("user-1"));
    await expect(repo.save(visit, [])).rejects.toBeInstanceOf(ConcurrentModificationError);
    expect(db.matching("insert into queue_entries")).toHaveLength(0);
    expect(db.matching("insert into events")).toHaveLength(0);
    expect(db.committed).toEqual([]);
  });

  it("refuses to insert over a visit that already exists", async () => {
    const { visit, deps } = newVisit();
    visit.pullEvents();
    db.willReturn([]);
    await expect(
      new PostgresVisitRepository(db, deps).save(visit, []),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
  });

  it("updates the mutable parts of a queue entry only", async () => {
    const { visit, deps } = newVisit();
    visit.pullEvents();
    db.willReturn([{ version: 0 }]);
    await new PostgresVisitRepository(db, deps).save(visit, []);

    const sql = db.matching("insert into queue_entries")[0]!.sql.toLowerCase();
    expect(sql).toContain("status = excluded.status");
    expect(sql).toContain("call_attempts = excluded.call_attempts");
    // queued_at is when they joined the queue; it never changes.
    expect(sql).not.toContain("queued_at = excluded");
  });

  it("writes nothing to events when there are none", async () => {
    const { visit, deps } = newVisit();
    visit.pullEvents();
    db.willReturn([{ version: 0 }]);
    await new PostgresVisitRepository(db, deps).save(visit, []);
    expect(db.matching("insert into events")).toHaveLength(0);
  });

  it("reissues a tracking token only for an open visit the tenant owns", async () => {
    const { deps } = newVisit();
    db.willReturn([{ id: "v" }]);
    const ok = await new PostgresVisitRepository(db, deps).reissueTrackingToken(
      HOSPITAL,
      VisitId("v"),
      "hash",
    );
    expect(ok).toBe(true);
    const sql = db.statements[0]!.sql.toLowerCase();
    expect(sql).toContain("b.hospital_id = $2");
    expect(sql).toContain("closed_at is null");
  });

  it("looks up an active visit by journey code, scoped to the branch", async () => {
    const deps = { clock: new FixedClock(), ids: new Ids() };
    const repo = new PostgresVisitRepository(db, deps);
    db.willReturn([]);

    await repo.findByJourneyCode(BRANCH, parseJourneyCode("QM-8F4K"));

    const [statement] = db.statements;
    expect(statement!.sql.toLowerCase()).toContain("closed_at is null");
    expect(statement!.params).toEqual([BRANCH, "QM-8F4K"]);
  });

  /**
   * Loading forty visits must not be forty-one round trips. Entries come back
   * in one query keyed by visit.
   */
  it("loads queue entries for many visits in a single query", async () => {
    const deps = { clock: new FixedClock(), ids: new Ids() };
    const repo = new PostgresVisitRepository(db, deps);

    db.willReturn([
      {
        id: "visit-1",
        branch_id: BRANCH,
        workflow_id: "wf-1",
        journey_code: "QM-8F4K",
        patient_name: "A",
        hospital_number: null,
        phone: null,
        status: "queued",
        priority: "normal",
        current_queue_entry_id: null,
        created_at: new Date(),
        completed_at: null,
        closed_at: null,
      },
      {
        id: "visit-2",
        branch_id: BRANCH,
        workflow_id: "wf-1",
        // Not "QM-2L7P": L is excluded from the journey-code alphabet, and the
        // mapper rejects it — which is the rule working end to end.
        journey_code: "QM-2K7P",
        patient_name: "B",
        hospital_number: null,
        phone: null,
        status: "queued",
        priority: "normal",
        current_queue_entry_id: null,
        created_at: new Date(),
        completed_at: null,
        closed_at: null,
      },
    ]);
    db.willReturn([]);

    const visits = await repo.activeInBranch(HOSPITAL, BRANCH);

    expect(visits).toHaveLength(2);
    const entryQueries = db.matching("from queue_entries");
    expect(entryQueries).toHaveLength(1);
    expect(entryQueries[0]!.sql).toContain("= ANY(");
    expect(entryQueries[0]!.params[0]).toEqual(["visit-1", "visit-2"]);
  });

  it("returns null rather than throwing for a code nobody holds", async () => {
    const deps = { clock: new FixedClock(), ids: new Ids() };
    db.willReturn([]);
    const found = await new PostgresVisitRepository(db, deps).findByJourneyCode(
      BRANCH,
      parseJourneyCode("QM-ZZZZ"),
    );
    expect(found).toBeNull();
  });

  it("checks journey code uniqueness among active visits only", async () => {
    const deps = { clock: new FixedClock(), ids: new Ids() };
    db.willReturn([{ exists: true }]);
    const taken = await new PostgresVisitRepository(
      db,
      deps,
    ).isJourneyCodeTaken(BRANCH, parseJourneyCode("QM-8F4K"));

    expect(taken).toBe(true);
    expect(db.statements[0]!.sql.toLowerCase()).toContain("closed_at is null");
  });

  it("finds visits open at a station by their queue entry status", async () => {
    const deps = { clock: new FixedClock(), ids: new Ids() };
    db.willReturn([]);
    await new PostgresVisitRepository(db, deps).openAtStation(HOSPITAL, CONSULT);

    const sql = db.statements[0]!.sql.toLowerCase();
    expect(sql).toContain("join queue_entries");
    expect(sql).toContain("'waiting', 'called', 'in_progress'");
  });
});

describe("event repository", () => {
  let db: FakeDatabase;
  let repo: PostgresEventRepository;

  beforeEach(() => {
    db = new FakeDatabase();
    repo = new PostgresEventRepository(db);
  });

  it("returns newest first and caps the page size", async () => {
    db.willReturn([]);
    await repo.query(HOSPITAL, { limit: 5000 });

    const sql = db.statements[0]!.sql.toLowerCase();
    expect(sql).toContain("order by sequence desc");
    // Capped, so one query cannot pull the whole history into memory.
    expect(db.statements[0]!.params).toContain(500);
  });

  it("separates the audit log from the activity timeline by category", async () => {
    db.willReturn([]);
    await repo.query(HOSPITAL, { categories: ["administrative", "security"] });

    expect(db.statements[0]!.sql).toContain("category = ANY($2)");
    expect(db.statements[0]!.params[1]).toEqual([
      "administrative",
      "security",
    ]);
  });

  it("combines filters with AND", async () => {
    db.willReturn([]);
    await repo.query(HOSPITAL, {
      visitId: "visit-1",
      actorId: UserId("user-doctor"),
      from: new Date("2026-03-09T00:00:00Z"),
    });

    const sql = db.statements[0]!.sql;
    expect(sql).toContain("visit_id = $2");
    expect(sql).toContain("actor_id = $3");
    expect(sql).toContain("occurred_at >= $4");
    // Three, not two: the unconditional hospital scope joins the two filters
    // this test supplies.
    expect(sql.match(/ AND /g)).toHaveLength(3);
  });

  /**
   * Values are never interpolated. The defence against injection is making the
   * unsafe thing impossible to express, not remembering to escape.
   */
  it("parameterises a search term rather than interpolating it", async () => {
    db.willReturn([]);
    await repo.query(HOSPITAL, { search: "'; DROP TABLE visits; --" });

    const [statement] = db.statements;
    expect(statement!.sql).not.toContain("DROP TABLE");
    expect(statement!.sql).toContain("plainto_tsquery('simple', $2)");
    expect(statement!.params[1]).toBe("'; DROP TABLE visits; --");
  });

  /**
   * The inverse of what this used to assert.
   *
   * It previously required *no* WHERE clause on an unfiltered query, which is
   * precisely the bug the release audit found: an unfiltered read returned
   * every organization's events. The tenant filter is unconditional now, so an
   * unfiltered query is scoped and nothing else.
   */
  it("always scopes to one hospital, even when nothing else is filtered", async () => {
    db.willReturn([]);
    await repo.query(HOSPITAL, {});
    const statement = db.statements[0]!;
    expect(statement.sql.toLowerCase()).toContain("where hospital_id = $1");
    expect(statement.params[0]).toBe(HOSPITAL);
  });

  it("returns a visit's history oldest first, so it reads as a story", async () => {
    db.willReturn([]);
    await repo.forVisit(HOSPITAL, VisitId("visit-1"));
    expect(db.statements[0]!.sql.toLowerCase()).toContain(
      "order by sequence asc",
    );
  });

  it("does nothing at all for an empty append", async () => {
    await repo.append([]);
    expect(db.statements).toHaveLength(0);
  });
});

describe("session repository", () => {
  let db: FakeDatabase;

  beforeEach(() => {
    db = new FakeDatabase();
  });

  it("lists only live sessions", async () => {
    db.willReturn([]);
    await new PostgresSessionRepository(db).activeForHospital();
    expect(db.statements[0]!.sql.toLowerCase()).toContain("ended_at is null");
  });

  it("ends every live session for a user and reports how many", async () => {
    db.willReturn([{ id: "s1" }, { id: "s2" }]);
    const ended = await new PostgresSessionRepository(db).endAllForUser(
      UserId("user-doctor"),
      "password_changed",
      new Date(),
    );

    expect(ended).toBe(2);
    const sql = db.statements[0]!.sql.toLowerCase();
    expect(sql).toContain("update sessions");
    // Already-ended sessions keep their original reason.
    expect(sql).toContain("ended_at is null");
  });
});

describe("ticket allocation", () => {
  /**
   * The one operation that genuinely needs the database. A read-then-write
   * would hand two receptions the same number; the upsert increments and reads
   * under a single row lock.
   */
  it("increments and reads under one statement", async () => {
    const db = new FakeDatabase();
    db.willReturn([{ last_value: 24 }]);

    const value = await new PostgresTicketAllocator(db).next(
      CONSULT,
      "2026-03-09",
    );

    expect(value).toBe(24);
    expect(db.statements).toHaveLength(1);
    const sql = db.statements[0]!.sql.toLowerCase();
    expect(sql).toContain("on conflict (station_id, period_key) do update");
    expect(sql).toContain("returning last_value");
  });

  it("scopes the series to the station and reset period", async () => {
    const db = new FakeDatabase();
    db.willReturn([{ last_value: 1 }]);
    await new PostgresTicketAllocator(db).next(LAB, "2026-W11");
    expect(db.statements[0]!.params).toEqual([LAB, "2026-W11"]);
  });

  it("fails loudly if allocation returns nothing", async () => {
    const db = new FakeDatabase();
    db.willReturn([]);
    await expect(
      new PostgresTicketAllocator(db).next(CONSULT, "2026-03-09"),
    ).rejects.toThrow(/no value/);
  });
});
