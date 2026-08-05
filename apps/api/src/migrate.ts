/**
 * Applies migrations and exits.
 *
 * Separate from the server so a hospital can migrate as its own step — before a
 * deploy, on a maintenance window, or from an administrator's machine against a
 * restored backup. The server also migrates on start, and both paths take the
 * same advisory lock, so running them together is safe rather than a race.
 */
import { migrate } from "@qman/persistence";
import { ConfigurationError, loadConfig } from "./config.js";
import { connect } from "./database.js";
import { createLogger } from "./logging.js";
import { loadMigrations } from "./migrations.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const { db, close } = connect(config, logger);

  try {
    const migrations = loadMigrations();
    const outcome = await migrate(db, migrations);

    if (outcome.applied.length === 0) {
      process.stdout.write(
        `Schema is already current — ${outcome.skipped.length} migration(s) applied previously.\n`,
      );
    } else {
      for (const name of outcome.applied) process.stdout.write(`Applied ${name}\n`);
      process.stdout.write(`\n${outcome.applied.length} migration(s) applied.\n`);
    }
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`Configuration error: ${error.message}\n`);
    process.exit(78);
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
