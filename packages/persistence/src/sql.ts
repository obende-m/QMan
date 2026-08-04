/**
 * The database boundary.
 *
 * One narrow port: run a parameterised statement, get rows back. Every
 * repository is written against it, so the SQL a repository issues — and the
 * order it issues it in — is testable with a recording fake, without Postgres
 * running anywhere.
 *
 * That matters more than usual here: the development environment has no
 * database, and code that can only be exercised against infrastructure nobody
 * has is code that ships unverified.
 */
export interface SqlExecutor {
  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

/**
 * A unit of work.
 *
 * Saving a visit writes the visit row, its queue entries and its events. Those
 * must land together: a queue entry without its visit is a patient in a queue
 * nobody can look up, and an event without its state change is a lie in the
 * audit trail.
 */
export interface Transactional {
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

export type Database = SqlExecutor & Transactional;

/**
 * A recording fake, for tests.
 *
 * Captures every statement and its parameters, and returns queued results. It
 * verifies what a repository *does* — which is the part that carries the bugs —
 * without pretending to be a SQL engine.
 */
export class FakeDatabase implements Database {
  readonly statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  #results: unknown[][] = [];
  #transactionDepth = 0;
  readonly committed: number[] = [];

  /** Queues the rows the next query will return. */
  willReturn(rows: unknown[]): this {
    this.#results.push(rows);
    return this;
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    this.statements.push({ sql, params });
    return (this.#results.shift() ?? []) as T[];
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.#transactionDepth += 1;
    try {
      const result = await work(this);
      this.committed.push(this.statements.length);
      return result;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  get inTransaction(): boolean {
    return this.#transactionDepth > 0;
  }

  /** Statements whose SQL contains the given fragment, case-insensitively. */
  matching(fragment: string): Array<{ sql: string; params: readonly unknown[] }> {
    const needle = fragment.toLowerCase();
    return this.statements.filter((s) =>
      s.sql.toLowerCase().includes(needle),
    );
  }

  reset(): void {
    this.statements.length = 0;
    this.#results = [];
    this.committed.length = 0;
  }
}

/**
 * Builds a parameterised WHERE clause.
 *
 * Conditions are assembled from `$n` placeholders and never by interpolating
 * values — the only reliable defence against injection is to make the unsafe
 * thing impossible to express, rather than to remember to escape.
 */
export class WhereBuilder {
  readonly #conditions: string[] = [];
  readonly #params: unknown[] = [];

  add(template: (placeholder: string) => string, value: unknown): this {
    this.#params.push(value);
    this.#conditions.push(template(`$${this.#params.length}`));
    return this;
  }

  addRaw(condition: string): this {
    this.#conditions.push(condition);
    return this;
  }

  get clause(): string {
    return this.#conditions.length === 0
      ? ""
      : ` WHERE ${this.#conditions.join(" AND ")}`;
  }

  get params(): readonly unknown[] {
    return this.#params;
  }

  /** Next placeholder index, for callers appending LIMIT and friends. */
  next(value: unknown): string {
    this.#params.push(value);
    return `$${this.#params.length}`;
  }
}
