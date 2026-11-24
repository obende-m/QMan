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
  PostgresAdministrationRepository,
  PostgresBoardDirectory,
  PostgresConfigurationRepository,
  PostgresConfigurationWriter,
  PostgresEventRepository,
  PostgresIdempotencyRepository,
  PostgresLockoutRepository,
  PostgresSessionRepository,
  PostgresTicketAllocator,
  PostgresVisitRepository,
  PostgresOrganizationDirectory,
  PostgresPlatformEventRepository,
  PostgresPlatformLockoutRepository,
  PostgresPlatformSessionRepository,
  PostgresPlatformUserRepository,
} from "@qman/persistence";
import { EventStream } from "./stream.js";
import { ConfigurationService } from "./configuration-service.js";
import { hashToken, issueToken } from "./tokens.js";
import { AuthService, createDatabaseLockoutStore } from "./auth.js";
import { ConfigurationError, loadConfig } from "./config.js";
import { connect } from "./database.js";
import { createLogger } from "./logging.js";
import { loadMigrations } from "./migrations.js";
import { buildServer } from "./server.js";
import { PlatformAuthService } from "./platform-auth.js";
import { createPlatformLockoutStore } from "./platform-lockout.js";
import { PostgresOrganizationProvisioning } from "./provisioning.js";
import { scheduleMaintenance } from "./maintenance.js";

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
  const organizations = new PostgresOrganizationDirectory(db);
  const accounts = new PostgresAccountRepository(db);
  const lockoutRepository = new PostgresLockoutRepository(db);
  const idempotencyRepository = new PostgresIdempotencyRepository(db);
  const eventRepository = new PostgresEventRepository(db);
  const auth = new AuthService({
    organizations,
    accounts,
    sessions: new PostgresSessionRepository(db),
    lockouts: createDatabaseLockoutStore(lockoutRepository, now),
    now,
    newId: () => randomUUID(),
  });

  const platformUsers = new PostgresPlatformUserRepository(db);
  const platformAuth = new PlatformAuthService({
    users: platformUsers,
    sessions: new PostgresPlatformSessionRepository(db),
    lockouts: createPlatformLockoutStore(new PostgresPlatformLockoutRepository(db), now),
    now,
  });

  const configurationWriter = new PostgresConfigurationWriter();
  const visitDependencies = { clock: { now }, ids: { next: randomUUID } };
  const visitRepository = new PostgresVisitRepository(db, visitDependencies);
  const stream = new EventStream();
  const app = buildServer({
    auth,
    organizations,
    platform: {
      auth: platformAuth,
      events: new PostgresPlatformEventRepository(db),
      users: platformUsers,
      provisioning: new PostgresOrganizationProvisioning(db, configurationWriter),
    },
    logger,
    stream,
    secureCookies: config.secureCookies,
    allowedOrigins: config.allowedOrigins,
    trustProxy: config.trustProxy,
    checkDatabase: async () => {
      await db.query("SELECT 1");
    },
    securityEvents: eventRepository,
    administration: {
      db,
      administration: new PostgresAdministrationRepository(db),
      accounts,
    },
    https: config.secureCookies,
    configuration: { configuration: new PostgresConfigurationRepository(db) },
    configurationWrites: {
      service: new ConfigurationService({ db, writer: configurationWriter, now }),
      writer: configurationWriter,
      idempotency: {
        repository: idempotencyRepository,
        logger,
        now,
      },
    },
    publicSurfaces: {
      visits: new PostgresVisitRepository(db, { clock: { now }, ids: { next: randomUUID } }),
      boards: new PostgresBoardDirectory(db),
      organizations,
      configuration: new PostgresConfigurationRepository(db),
    },
    queue: {
      visits: visitRepository,
      events: eventRepository,
      admission: {
        visits: visitRepository,
        allocator: new PostgresTicketAllocator(db),
        deps: visitDependencies,
        configuration: new PostgresConfigurationRepository(db),
        newTrackingToken: issueToken,
        hashToken,
      },
      idempotency: {
        repository: idempotencyRepository,
        logger,
        now,
      },
    },
  });

  /*
   * Visit closure and pruning. Runs in this process: one more instance only
   * means two runs that each lose the visits the other already closed, which
   * the versioned save makes harmless.
   */
  const stopMaintenance = scheduleMaintenance(
    {
      visits: visitRepository,
      stream,
      logger,
      now,
      policy: {
        closeAfterMinutes: config.visitClosure.closeAfterMinutes,
        abandonAfterHours: config.visitClosure.abandonAfterHours,
      },
      idempotency: idempotencyRepository,
      lockouts: lockoutRepository,
    },
    config.visitClosure.intervalSeconds * 1000,
  );

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
      await stopMaintenance();
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
