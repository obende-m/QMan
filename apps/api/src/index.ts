/**
 * The server entry point.
 *
 * Starts in a fixed order, and refuses to serve if any step fails: read
 * configuration, connect, migrate, listen. A server that accepts requests
 * before its schema is current answers them wrongly, which is worse than not
 * answering at all — a clinic that cannot reach QMan falls back to paper, while
 * one that reaches a half-migrated QMan does not know to.
 */
import { randomUUID } from "node:crypto";
import {
  migrate,
  PostgresAccountRepository,
  PostgresEventRepository,
  PostgresLockoutRepository,
  PostgresSessionRepository,
  PostgresVisitRepository,
} from "@qman/persistence";
import { EventStream } from "./stream.js";
import { AuthService, createDatabaseLockoutStore } from "./auth.js";
import { ConfigurationError, loadConfig } from "./config.js";
import { connect } from "./database.js";
import { createLogger } from "./logging.js";
import { loadMigrations } from "./migrations.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  const { db, close } = connect(config, logger);

  const outcome = await migrate(db, loadMigrations());
  logger.info("schema is current", {
    applied: outcome.applied,
    alreadyApplied: outcome.skipped.length,
  });

  const now = (): Date => new Date();
  const auth = new AuthService({
    accounts: new PostgresAccountRepository(db),
    sessions: new PostgresSessionRepository(db),
    lockouts: createDatabaseLockoutStore(new PostgresLockoutRepository(db), now),
    now,
    newId: () => randomUUID(),
  });

  const stream = new EventStream();
  const app = buildServer({
    auth,
    logger,
    stream,
    resolveHospital: () => config.hospitalId,
    secureCookies: config.secureCookies,
    allowedOrigins: config.allowedOrigins,
    https: config.secureCookies,
    queue: {
      visits: new PostgresVisitRepository(db, { clock: { now }, ids: { next: randomUUID } }),
      events: new PostgresEventRepository(db),
    },
  });

  /**
   * Finish in-flight requests before exiting.
   *
   * A container restart mid-request would otherwise abandon a receptionist's
   * admission halfway through, and the transaction it was inside would roll
   * back without anything telling them.
   */
  const stop = async (signal: string): Promise<void> => {
    logger.info("shutting down", { signal });
    try {
      await app.close();
      await close();
      process.exit(0);
    } catch (error) {
      logger.error("shutdown failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
  logger.info("listening", {
    host: config.host,
    port: config.port,
    hospitalId: config.hospitalId,
    secureCookies: config.secureCookies,
    allowedOrigins: config.allowedOrigins,
  });

  if (!config.secureCookies) {
    logger.warn(
      "session cookies are not marked Secure — acceptable for local development only",
    );
  }
}

main().catch((error: unknown) => {
  // Configuration mistakes are the common case and deserve a plain message
  // rather than a stack trace someone has to read past.
  if (error instanceof ConfigurationError) {
    process.stderr.write(`Configuration error: ${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
