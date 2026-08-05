import { describe, expect, it } from "vitest";
import { FakeDatabase } from "./sql.js";
import { checksum, migrate, MigrationIntegrityError, type Migration } from "./migrator.js";

const initial: Migration = { name: "001_initial", sql: "CREATE TABLE hospitals ()" };
const sessions: Migration = { name: "002_session_tokens", sql: "ALTER TABLE sessions ()" };

/** Queues the two empty results the runner reads before the applied list. */
function ready(db: FakeDatabase, applied: unknown[] = []): FakeDatabase {
  return db.willReturn([]).willReturn([]).willReturn(applied);
}

describe("migration runner", () => {
  it("applies pending migrations in name order and records them", async () => {
    const db = ready(new FakeDatabase());

    // Deliberately out of order: the runner sorts, the caller need not.
    const outcome = await migrate(db, [sessions, initial]);

    expect(outcome.applied).toEqual(["001_initial", "002_session_tokens"]);
    expect(outcome.skipped).toEqual([]);

    const applied = db.statements
      .map((s) => s.sql)
      .filter((sql) => sql.includes("CREATE TABLE hospitals") || sql.includes("ALTER TABLE sessions"));
    expect(applied).toEqual(["CREATE TABLE hospitals ()", "ALTER TABLE sessions ()"]);

    const recorded = db.matching("INSERT INTO schema_migrations");
    expect(recorded.map((s) => s.params[0])).toEqual([
      "001_initial",
      "002_session_tokens",
    ]);
  });

  it("runs the whole migration under one transaction and one advisory lock", async () => {
    const db = ready(new FakeDatabase());

    await migrate(db, [initial, sessions]);

    expect(db.committed).toHaveLength(1);
    expect(db.matching("pg_advisory_xact_lock")).toHaveLength(1);
    // The lock is taken before anything reads or writes schema.
    expect(db.statements[0]?.sql).toContain("pg_advisory_xact_lock");
  });

  it("creates the ledger if it is not there", async () => {
    const db = ready(new FakeDatabase());
    await migrate(db, [initial]);
    expect(db.matching("CREATE TABLE IF NOT EXISTS schema_migrations")).toHaveLength(1);
  });

  it("skips a migration that has already been applied", async () => {
    const db = ready(new FakeDatabase(), [
      { name: "001_initial", checksum: checksum(initial.sql) },
    ]);

    const outcome = await migrate(db, [initial, sessions]);

    expect(outcome.skipped).toEqual(["001_initial"]);
    expect(outcome.applied).toEqual(["002_session_tokens"]);
    expect(db.matching("CREATE TABLE hospitals")).toHaveLength(0);
  });

  /**
   * The failure this exists to prevent: a migration edited after it ran, so the
   * schema matches no other deployment and nothing says so until something
   * breaks in clinic.
   */
  it("refuses to continue when an applied migration has changed", async () => {
    const db = ready(new FakeDatabase(), [
      { name: "001_initial", checksum: checksum("CREATE TABLE hospitals (id uuid)") },
    ]);

    await expect(migrate(db, [initial])).rejects.toThrow(MigrationIntegrityError);
    await expect(migrate(ready(new FakeDatabase(), [
      { name: "001_initial", checksum: checksum("something else") },
    ]), [initial])).rejects.toThrow(/has changed since it was applied/);
  });

  it("refuses to run against a database migrated by a newer build", async () => {
    const db = ready(new FakeDatabase(), [
      { name: "001_initial", checksum: checksum(initial.sql) },
      { name: "003_from_the_future", checksum: "whatever" },
    ]);

    await expect(migrate(db, [initial])).rejects.toThrow(/newer version of QMan/);
  });

  it("rejects a migration that manages its own transaction", async () => {
    const db = ready(new FakeDatabase());
    const selfManaged: Migration = {
      name: "003_bad",
      sql: "BEGIN;\nALTER TABLE visits ADD COLUMN x text;\nCOMMIT;",
    };

    await expect(migrate(db, [selfManaged])).rejects.toThrow(/transaction control/);
  });

  it("rejects two migrations sharing a name", async () => {
    const db = ready(new FakeDatabase());
    await expect(
      migrate(db, [initial, { name: "001_initial", sql: "SELECT 2" }]),
    ).rejects.toThrow(/must be unique/);
  });

  it("is insensitive to the line endings a checkout produced", () => {
    expect(checksum("CREATE TABLE a ();\nCREATE TABLE b ();")).toBe(
      checksum("CREATE TABLE a ();\r\nCREATE TABLE b ();"),
    );
    expect(checksum("SELECT 1")).not.toBe(checksum("SELECT 2"));
  });
});
