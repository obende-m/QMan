/**
 * Loads migration files from the persistence package.
 *
 * They live beside the schema they define rather than being copied here,
 * because two copies of a migration is exactly the situation the checksum check
 * exists to detect — and it would detect it in a hospital, at install time.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Migration } from "@qman/persistence";

const require = createRequire(import.meta.url);

export function migrationsDirectory(): string {
  return join(dirname(require.resolve("@qman/persistence/package.json")), "migrations");
}

export function loadMigrations(directory = migrationsDirectory()): Migration[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      // The file name without its extension, so renaming a file is a visible
      // integrity failure rather than a silent re-application.
      name: name.replace(/\.sql$/, ""),
      sql: readFileSync(join(directory, name), "utf8"),
    }));
}
