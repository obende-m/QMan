/**
 * The migration runner.
 *
 * Migrations arrive as data — a name and a body of SQL — rather than being read
 * from disk here, so the runner has no filesystem dependency and its ordering,
 * locking and integrity rules are testable without a database or a directory
 * layout. The API app supplies the files.
 *
 * Three properties matter more than the mechanism:
 *
 * Only one process may migrate at a time. Two servers restarting together after
 * a power cut would otherwise apply the same migration twice.
 *
 * An applied migration is never re-applied, and never silently changes. Editing
 * a migration that has already run produces a schema that matches no other
 * deployment, and the divergence is invisible until something fails at 9am.
 *
 * The run is all-or-nothing. PostgreSQL supports transactional DDL, so a failed
 * migration leaves the schema exactly as it was rather than half-converted.
 */
import type { Database } from "./sql.js";

export interface Migration {
  /** Sort key and identity. Conventionally `001_initial`. */
  readonly name: string;
  readonly sql: string;
}

export interface MigrationOutcome {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Raised when a migration on disk no longer matches the one that was applied.
 *
 * Recoverable only by a human: either the edit was a mistake and should be
 * reverted, or it was intentional and belongs in a new migration.
 */
export class MigrationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationIntegrityError";
  }
}

/**
 * A lock key derived from nothing in particular, but fixed forever.
 *
 * Taken as a transaction-scoped advisory lock, so it is released when the
 * migration transaction ends — including when the process is killed mid-run,
 * which a session-scoped lock would survive and deadlock the next start.
 */
const MIGRATION_LOCK_KEY = 0x716d616e; // "qman"

/**
 * FNV-1a over the migration text.
 *
 * Not a cryptographic hash and not trying to be: the risk being detected is an
 * accidental edit to a migration that has already run, not an adversary
 * constructing a collision. Someone able to rewrite migration files can rewrite
 * the checksums beside them whatever the algorithm.
 *
 * Line endings are normalised first. A checkout on Windows would otherwise
 * produce a different digest for the same file and report every migration as
 * tampered with.
 */
export function checksum(sql: string): string {
  const normalised = sql.replace(/\r\n/g, "\n");
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < normalised.length; i += 1) {
    hash ^= BigInt(normalised.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

interface AppliedRow {
  name: string;
  checksum: string;
}

export async function migrate(
  db: Database,
  migrations: readonly Migration[],
): Promise<MigrationOutcome> {
  const duplicate = migrations
    .map((m) => m.name)
    .find((name, index, all) => all.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new MigrationIntegrityError(
      `Two migrations are named "${duplicate}". Names are identities and must be unique.`,
    );
  }

  // The runner owns the transaction. A migration that opens its own would
  // commit the run early, and the all-or-nothing guarantee would be silently
  // gone rather than visibly broken.
  const transactional = migrations.find((m) =>
    /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/im.test(m.sql),
  );
  if (transactional !== undefined) {
    throw new MigrationIntegrityError(
      `Migration "${transactional.name}" contains its own transaction control. ` +
        `The runner wraps every migration in a transaction; remove BEGIN, COMMIT and ROLLBACK.`,
    );
  }

  const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name));

  return db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock($1)`, [MIGRATION_LOCK_KEY]);

    await tx.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
          name       text        PRIMARY KEY,
          checksum   text        NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const rows = await tx.query<AppliedRow>(
      `SELECT name, checksum FROM schema_migrations`,
    );
    const already = new Map(rows.map((row) => [row.name, row.checksum]));

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const migration of ordered) {
      const digest = checksum(migration.sql);
      const previous = already.get(migration.name);

      if (previous !== undefined) {
        if (previous !== digest) {
          throw new MigrationIntegrityError(
            `Migration "${migration.name}" has changed since it was applied ` +
              `(recorded ${previous}, now ${digest}). Add a new migration instead of editing one that has run.`,
          );
        }
        skipped.push(migration.name);
        continue;
      }

      await tx.query(migration.sql);
      await tx.query(
        `INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`,
        [migration.name, digest],
      );
      applied.push(migration.name);
    }

    // A recorded migration with no file means this build is older than the
    // database it is pointed at. Continuing would run application code against
    // a schema it does not know about.
    const known = new Set(ordered.map((m) => m.name));
    const unknown = [...already.keys()].filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new MigrationIntegrityError(
        `The database has migrations this build does not contain: ${unknown.join(", ")}. ` +
          `It was migrated by a newer version of QMan.`,
      );
    }

    return { applied, skipped };
  });
}
