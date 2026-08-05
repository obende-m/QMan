/**
 * The connection pool.
 *
 * The one place in the server that knows the driver. Everything else works
 * against the `Database` port, so replacing `pg` — or pointing at a different
 * PostgreSQL — touches this file alone.
 */
import pg from "pg";
import { createPostgresDatabase, type Database } from "@qman/persistence";
import type { Config } from "./config.js";
import type { Logger } from "./logging.js";

/** Statements slower than this are worth someone's attention. */
const SLOW_QUERY_MILLIS = 200;

export interface DatabaseHandle {
  readonly db: Database;
  close(): Promise<void>;
}

export function connect(config: Config, logger: Logger): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.poolSize,
    // Managed providers terminate idle connections; reconnecting on demand is
    // cheaper than discovering a dead socket mid-request.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    /**
     * Certificates are verified by default.
     *
     * `rejectUnauthorized: false` is the line most commonly copied into
     * production from a getting-started guide, and it turns TLS into
     * encryption without authentication: the connection is unreadable to a
     * passive observer and completely open to anyone able to answer in the
     * database's place. Every managed provider presents a certificate that
     * verifies, so this costs nothing there. A hospital running its own server
     * with a self-signed certificate is the one case that needs the opt-out.
     */
    ...(config.databaseSsl
      ? { ssl: { rejectUnauthorized: !config.databaseSslInsecure } }
      : {}),
  });

  // A pool error is emitted on idle connections, away from any request. Without
  // a listener Node treats it as unhandled and ends the process — taking the
  // clinic's server down because one spare connection was reset.
  pool.on("error", (error) => {
    logger.error("idle database connection failed", { error: error.message });
  });

  const db = createPostgresDatabase(pool, {
    onQuery: (event) => {
      if (event.failed) {
        logger.error("statement failed", {
          sql: event.sql,
          parameterCount: event.parameterCount,
          durationMillis: event.durationMillis,
        });
      } else if (event.durationMillis >= SLOW_QUERY_MILLIS) {
        logger.warn("slow statement", {
          sql: event.sql,
          rowCount: event.rowCount,
          durationMillis: event.durationMillis,
        });
      }
    },
  });

  return { db, close: () => pool.end() };
}
