/**
 * The PostgreSQL adapter.
 *
 * Implements the `Database` port over a connection pool. It is written against
 * a structural description of that pool rather than an import of `pg`, for two
 * reasons.
 *
 * The first is that it keeps this package free of runtime dependencies, so the
 * domain and its storage rules stay portable — deploying to a self-hosted
 * server, a managed service or a developer's laptop is a connection string,
 * never a code change. Nothing here uses a vendor extension.
 *
 * The second is testability. The behaviour that carries the bugs is not the
 * SQL; it is whether a unit of work actually ran on one connection, and whether
 * a failure rolled back. Both are observable through this interface with a fake
 * pool, which means they are verified on every test run rather than only when
 * someone remembers to point the suite at a real server.
 */
import type { Database, SqlExecutor } from "./sql.js";

/**
 * What a query resolves to. A single statement gives one result; a text holding
 * several statements, such as a migration file, gives one result per statement.
 */
export type QueryResultLike = { rows: unknown[] } | ReadonlyArray<{ rows: unknown[] }>;

/** The slice of a pooled client this adapter uses. */
export interface PoolClientLike {
  query(text: string, values?: readonly unknown[]): Promise<QueryResultLike>;
  /** `true` discards the connection instead of returning it to the pool. */
  release(destroy?: boolean): void;
}

/** The slice of a connection pool this adapter uses. */
export interface PoolLike {
  query(text: string, values?: readonly unknown[]): Promise<QueryResultLike>;
  connect(): Promise<PoolClientLike>;
}

/**
 * What a completed statement reports.
 *
 * Parameters are counted, never included. They carry patient names, phone
 * numbers and hospital numbers, and a log file is the least controlled copy of
 * a database that exists — it is read by more people, retained longer and
 * protected less. The statement text is a constant in the source and is safe;
 * the values bound to it are not.
 */
export interface QueryEvent {
  readonly sql: string;
  readonly parameterCount: number;
  readonly rowCount: number;
  readonly durationMillis: number;
  readonly failed: boolean;
}

export interface PostgresOptions {
  /** Called after every statement, for structured logging and slow-query alerts. */
  readonly onQuery?: (event: QueryEvent) => void;
}

/**
 * The rows of a query's final statement.
 *
 * A multi-statement text resolves to an array of results, which has no `rows`
 * of its own. Reading it as a single result threw after the statements had
 * succeeded, so the enclosing transaction rolled back work that was correct.
 */
function rowsOf(result: QueryResultLike): unknown[] {
  if (Array.isArray(result)) {
    const last = result[result.length - 1] as { rows?: unknown[] } | undefined;
    return last?.rows ?? [];
  }
  return (result as { rows?: unknown[] }).rows ?? [];
}

function elapsed(startedAt: number): number {
  return Math.round((Date.now() - startedAt) * 1000) / 1000;
}

async function run<T>(
  source: { query(text: string, values?: readonly unknown[]): Promise<QueryResultLike> },
  sql: string,
  params: readonly unknown[],
  onQuery: ((event: QueryEvent) => void) | undefined,
): Promise<T[]> {
  const startedAt = Date.now();
  try {
    const rows = rowsOf(await source.query(sql, params));
    onQuery?.({
      sql,
      parameterCount: params.length,
      rowCount: rows.length,
      durationMillis: elapsed(startedAt),
      failed: false,
    });
    return rows as T[];
  } catch (error) {
    onQuery?.({
      sql,
      parameterCount: params.length,
      rowCount: 0,
      durationMillis: elapsed(startedAt),
      failed: true,
    });
    throw error;
  }
}

/**
 * A unit of work bound to one checked-out connection.
 *
 * Every statement a repository issues inside `transaction` reaches the same
 * backend as its `BEGIN`. Issuing them through the pool instead would scatter
 * them across connections, and `COMMIT` would end an empty transaction while
 * the real writes landed outside it — the failure mode being that everything
 * looks correct until the day a rollback is needed.
 */
class ClientExecutor implements Database {
  readonly #client: PoolClientLike;
  readonly #onQuery: ((event: QueryEvent) => void) | undefined;

  constructor(client: PoolClientLike, onQuery: ((event: QueryEvent) => void) | undefined) {
    this.#client = client;
    this.#onQuery = onQuery;
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return run<T>(this.#client, sql, params, this.#onQuery);
  }

  /**
   * Joins the transaction already in progress rather than opening another.
   *
   * Nesting is detected by which executor the caller holds, not by state on the
   * pool, so two concurrent units of work cannot mistake each other's
   * transaction for their own. The consequence is that an inner failure rolls
   * back the whole unit of work, which is the correct reading: a visit saved
   * without its events is not a partial success.
   */
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }
}

class PostgresDatabase implements Database {
  readonly #pool: PoolLike;
  readonly #onQuery: ((event: QueryEvent) => void) | undefined;

  constructor(pool: PoolLike, options: PostgresOptions) {
    this.#pool = pool;
    this.#onQuery = options.onQuery;
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return run<T>(this.#pool, sql, params, this.#onQuery);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    const executor = new ClientExecutor(client, this.#onQuery);
    let poisoned = false;

    try {
      await executor.query("BEGIN");
      const result = await work(executor);
      await executor.query("COMMIT");
      return result;
    } catch (error) {
      // A connection whose rollback failed is of unknown transactional state.
      // Returning it to the pool hands the next caller an open transaction.
      try {
        await executor.query("ROLLBACK");
      } catch {
        poisoned = true;
      }
      throw error;
    } finally {
      client.release(poisoned);
    }
  }
}

export function createPostgresDatabase(
  pool: PoolLike,
  options: PostgresOptions = {},
): Database {
  return new PostgresDatabase(pool, options);
}
