import { describe, expect, it } from "vitest";
import { createPostgresDatabase, type PoolClientLike, type PoolLike, type QueryEvent } from "./pg.js";

class FakeClient implements PoolClientLike {
  readonly statements: string[] = [];
  released = false;
  destroyed = false;
  failOn: string | null = null;

  constructor(readonly id: number) {}

  async query(text: string): Promise<{ rows: unknown[] }> {
    this.statements.push(text);
    if (this.failOn !== null && text.includes(this.failOn)) {
      throw new Error(`statement failed: ${text}`);
    }
    return { rows: [] };
  }

  release(destroy?: boolean): void {
    this.released = true;
    this.destroyed = destroy === true;
  }
}

class FakePool implements PoolLike {
  readonly clients: FakeClient[] = [];
  readonly poolStatements: string[] = [];
  /** Applied to each client as it is handed out. */
  failOn: string | null = null;

  async query(text: string): Promise<{ rows: unknown[] }> {
    this.poolStatements.push(text);
    return { rows: [] };
  }

  async connect(): Promise<PoolClientLike> {
    const client = new FakeClient(this.clients.length);
    client.failOn = this.failOn;
    this.clients.push(client);
    return client;
  }
}

describe("postgres adapter", () => {
  it("runs a unit of work on one checked-out connection, not the pool", async () => {
    const pool = new FakePool();
    const db = createPostgresDatabase(pool);

    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO visits DEFAULT VALUES");
      await tx.query("INSERT INTO events DEFAULT VALUES");
    });

    expect(pool.clients).toHaveLength(1);
    expect(pool.clients[0]!.statements).toEqual([
      "BEGIN",
      "INSERT INTO visits DEFAULT VALUES",
      "INSERT INTO events DEFAULT VALUES",
      "COMMIT",
    ]);
    // Nothing leaked onto a second connection, where COMMIT would not cover it.
    expect(pool.poolStatements).toEqual([]);
  });

  it("rolls back and rethrows when the work fails", async () => {
    const pool = new FakePool();
    const db = createPostgresDatabase(pool);

    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO visits DEFAULT VALUES");
        throw new Error("domain rejected the transition");
      }),
    ).rejects.toThrow("domain rejected the transition");

    expect(pool.clients[0]!.statements).toEqual([
      "BEGIN",
      "INSERT INTO visits DEFAULT VALUES",
      "ROLLBACK",
    ]);
  });

  it("returns the connection to the pool whether the work succeeded or not", async () => {
    const pool = new FakePool();
    const db = createPostgresDatabase(pool);

    await db.transaction(async () => undefined);
    await expect(
      db.transaction(async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow();

    expect(pool.clients.map((c) => c.released)).toEqual([true, true]);
    expect(pool.clients.map((c) => c.destroyed)).toEqual([false, false]);
  });

  /**
   * A connection whose ROLLBACK did not land is of unknown transactional state.
   * Returned to the pool, the next caller inherits an open transaction.
   */
  it("discards a connection whose rollback failed", async () => {
    const pool = new FakePool();
    pool.failOn = "ROLLBACK";
    const db = createPostgresDatabase(pool);

    await expect(
      db.transaction(async () => {
        throw new Error("original failure");
      }),
    ).rejects.toThrow("original failure");

    expect(pool.clients[0]!.destroyed).toBe(true);
  });

  it("joins an existing transaction rather than opening a second one", async () => {
    const pool = new FakePool();
    const db = createPostgresDatabase(pool);

    await db.transaction(async (tx) => {
      await (tx as typeof db).transaction(async (inner) => {
        await inner.query("INSERT INTO events DEFAULT VALUES");
      });
    });

    expect(pool.clients).toHaveLength(1);
    expect(pool.clients[0]!.statements.filter((s) => s === "BEGIN")).toHaveLength(1);
    expect(pool.clients[0]!.statements.filter((s) => s === "COMMIT")).toHaveLength(1);
  });

  /**
   * Nesting is detected by which executor the caller holds. Were it tracked on
   * the adapter, two overlapping units of work would mistake each other's
   * transaction for their own and commit together.
   */
  it("keeps concurrent units of work on separate connections", async () => {
    const pool = new FakePool();
    const db = createPostgresDatabase(pool);
    const release: Array<() => void> = [];

    const gate = (): Promise<void> =>
      new Promise<void>((resolve) => release.push(resolve));

    const first = db.transaction(async (tx) => {
      await tx.query("INSERT INTO visits DEFAULT VALUES");
      await gate();
    });
    const second = db.transaction(async (tx) => {
      await tx.query("INSERT INTO queue_entries DEFAULT VALUES");
      await gate();
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    release.forEach((resolve) => resolve());
    await Promise.all([first, second]);

    expect(pool.clients).toHaveLength(2);
    expect(pool.clients[0]!.statements).toContain("INSERT INTO visits DEFAULT VALUES");
    expect(pool.clients[0]!.statements).not.toContain(
      "INSERT INTO queue_entries DEFAULT VALUES",
    );
  });

  it("reports every statement for logging, including failures", async () => {
    const pool = new FakePool();
    pool.failOn = "boom";
    const events: QueryEvent[] = [];
    const db = createPostgresDatabase(pool, { onQuery: (event) => events.push(event) });

    await expect(
      db.transaction(async (tx) => {
        await tx.query("SELECT boom");
      }),
    ).rejects.toThrow();

    const failed = events.find((event) => event.sql === "SELECT boom");
    expect(failed?.failed).toBe(true);
    expect(events.some((event) => event.sql === "BEGIN" && !event.failed)).toBe(true);
  });

  /**
   * Parameters carry patient names, phone numbers and hospital numbers. A log
   * file is the least controlled copy of a database that exists.
   */
  it("counts parameters without exposing their values", async () => {
    const pool = new FakePool();
    const events: QueryEvent[] = [];
    const db = createPostgresDatabase(pool, { onQuery: (event) => events.push(event) });

    await db.query("SELECT * FROM visits WHERE patient_name = $1 AND phone = $2", [
      "Amara Okafor",
      "+2348012345678",
    ]);

    const [event] = events;
    expect(event?.parameterCount).toBe(2);
    expect(JSON.stringify(events)).not.toContain("Amara");
    expect(JSON.stringify(events)).not.toContain("2348012345678");
  });

  // A migration file is several statements in one text, and the driver answers
  // it with one result per statement. With a logger attached, reading that as
  // a single result threw after the statements had run, and the transaction
  // rolled back a migration that had succeeded.
  it("accepts a multi-statement result, with a logger attached, inside a transaction", async () => {
    const multi: PoolLike = {
      async query() {
        return [{ rows: [] }, { rows: [{ n: 1 }] }];
      },
      async connect() {
        return {
          async query(text: string) {
            return text.includes(";") ? [{ rows: [] }, { rows: [{ n: 1 }] }] : { rows: [] };
          },
          release() {},
        };
      },
    };
    const events: QueryEvent[] = [];
    const db = createPostgresDatabase(multi, { onQuery: (event) => events.push(event) });

    const rows = await db.transaction((tx) => tx.query("CREATE TABLE a (n int); SELECT 1 AS n;"));
    expect(rows).toEqual([{ n: 1 }]);
    expect(await db.query("SELECT 1; SELECT 1 AS n")).toEqual([{ n: 1 }]);
    expect(events.every((e) => !e.failed)).toBe(true);
    expect(events.find((e) => e.sql.startsWith("CREATE"))?.rowCount).toBe(1);
  });
});
