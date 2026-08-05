import { describe, expect, it } from "vitest";
import { ConfigurationError, loadConfig } from "./config.js";
import { loadMigrations, migrationsDirectory } from "./migrations.js";

const MINIMUM = {
  DATABASE_URL: "postgres://qman:secret@db.example:5432/qman",
  QMAN_HOSPITAL_ID: "11111111-1111-1111-1111-111111111111",
} satisfies NodeJS.ProcessEnv;

describe("configuration", () => {
  it("refuses to start without a database or a hospital", () => {
    expect(() => loadConfig({})).toThrow(ConfigurationError);
    expect(() => loadConfig({ DATABASE_URL: MINIMUM.DATABASE_URL })).toThrow(
      /QMAN_HOSPITAL_ID/,
    );
  });

  /**
   * The failure belongs at startup, where someone is watching, not at the first
   * sign-in in a clinic where nobody can fix it.
   */
  it("rejects malformed values rather than falling back to a default", () => {
    expect(() => loadConfig({ ...MINIMUM, PORT: "not-a-port" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...MINIMUM, PORT: "-1" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...MINIMUM, LOG_LEVEL: "chatty" })).toThrow(/LOG_LEVEL/);
    expect(() => loadConfig({ ...MINIMUM, QMAN_SECURE_COOKIES: "maybe" })).toThrow(
      /QMAN_SECURE_COOKIES/,
    );
  });

  /** A deployment that forgot the variable must not be the one without Secure. */
  it("marks cookies Secure unless told otherwise", () => {
    expect(loadConfig(MINIMUM).secureCookies).toBe(true);
    expect(loadConfig({ ...MINIMUM, QMAN_SECURE_COOKIES: "false" }).secureCookies).toBe(false);
  });

  it("expects TLS to the database except on localhost", () => {
    expect(loadConfig(MINIMUM).databaseSsl).toBe(true);
    expect(
      loadConfig({ ...MINIMUM, DATABASE_URL: "postgres://localhost:5432/qman" }).databaseSsl,
    ).toBe(false);
  });

  it("is quiet by default", () => {
    expect(loadConfig(MINIMUM).logLevel).toBe("info");
  });
});

describe("migration loading", () => {
  it("finds the migrations that ship with the persistence package", () => {
    const migrations = loadMigrations(migrationsDirectory());
    expect(migrations.map((m) => m.name)).toEqual(["001_initial", "002_session_tokens"]);
    expect(migrations[0]!.sql).toContain("CREATE TABLE hospitals");
  });
});
