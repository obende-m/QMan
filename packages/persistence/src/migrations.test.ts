/**
 * Portability rules for the schema itself.
 *
 * QMan has to install on whatever PostgreSQL a hospital already has or can
 * afford — a managed instance at Render, Neon, Railway, DigitalOcean, Supabase,
 * RDS or Azure, or a server in a back office. Those differ most in what they
 * refuse to let you do, and the differences surface at install or restore time,
 * which is the worst moment to discover them.
 *
 * So the rules are checked here rather than trusted: stock PostgreSQL 13 or
 * later, no extensions, no vendor features, and nothing that cannot run inside
 * the runner's transaction. A migration that breaks one of these fails the test
 * suite instead of a hospital's first install.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const directory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const files = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const migrations = files.map((name) => ({
  name,
  sql: readFileSync(join(directory, name), "utf8"),
}));

/** Strips comments, so prose about a construct is not mistaken for using it. */
function statements(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("migration portability", () => {
  it("has migrations to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  /**
   * CREATE EXTENSION is privileged, and several managed providers restrict or
   * refuse it. `gen_random_uuid()` is core from PostgreSQL 13, which is the only
   * thing pgcrypto was ever needed for here.
   */
  it.each(migrations)("$name requires no extensions", ({ sql }) => {
    expect(statements(sql)).not.toMatch(/CREATE\s+EXTENSION/i);
  });

  it.each(migrations)("$name uses no extension-provided functions", ({ sql }) => {
    const body = statements(sql);
    for (const symbol of [
      "uuid_generate_v4", // uuid-ossp
      "crypt(", // pgcrypto
      "gen_salt(", // pgcrypto
      "digest(", // pgcrypto
      "citext", // citext
      "unaccent(", // unaccent
    ]) {
      expect(body.toLowerCase()).not.toContain(symbol.toLowerCase());
    }
  });

  /**
   * A UNIQUE table constraint takes bare column names. Written with an
   * expression it does not create a weaker rule — it fails to parse, on every
   * PostgreSQL there is. Expressions belong in a unique index.
   */
  it.each(migrations)("$name puts expressions in indexes, not constraints", ({ sql }) => {
    expect(statements(sql)).not.toMatch(/\bUNIQUE\s*\([^)]*\(/i);
  });

  /** The runner owns the transaction; a migration's own COMMIT would end it. */
  it.each(migrations)("$name does not manage transactions", ({ sql }) => {
    expect(statements(sql)).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/im);
  });

  /** CREATE INDEX CONCURRENTLY cannot run inside a transaction block. */
  it.each(migrations)("$name avoids CONCURRENTLY", ({ sql }) => {
    expect(statements(sql)).not.toMatch(/CONCURRENTLY/i);
  });

  it("numbers migrations uniquely and in order", () => {
    const prefixes = files.map((name) => name.slice(0, 3));
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect([...prefixes].sort()).toEqual(prefixes);
  });
});
