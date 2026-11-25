/**
 * The bootstrap entry point.
 *
 * Separate from `bootstrap.ts` so the logic can be tested without running the
 * process — importing a module that calls `process.exit` on load is not a thing
 * a test can do twice.
 */
import { ConfigurationError } from "./config.js";
import { main } from "./bootstrap.js";

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`\n  ${error.message}\n\n`);
    process.exit(1);
  }
  process.stderr.write(`\n  Bootstrap failed: ${(error as Error).message}\n\n`);
  process.exit(1);
});
