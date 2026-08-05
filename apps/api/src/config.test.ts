import { describe, expect, it } from "vitest";
import { ConfigurationError, loadConfig } from "./config.js";
import { loadMigrations, migrationsDirectory } from "./migrations.js";

const MINIMUM = {
  DATABASE_URL: "postgres://qman:secret@db.example:5432/qman",
  QMAN_HOSPITAL_ID: "11111111-1111-1111-1111-111111111111",
  QMAN_ALLOWED_ORIGINS: "https://qman.hospital.example",
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

  /**
   * A control that is off unless configured is a control most deployments do
   * not have. There is deliberately no permissive default here.
   */
  it("requires the origins allowed to make state-changing requests", () => {
    const { QMAN_ALLOWED_ORIGINS: _omitted, ...without } = MINIMUM;
    expect(() => loadConfig(without)).toThrow(/QMAN_ALLOWED_ORIGINS/);
  });

  it("accepts several origins and rejects anything that is not one", () => {
    expect(
      loadConfig({
        ...MINIMUM,
        QMAN_ALLOWED_ORIGINS: "https://qman.example, https://board.qman.example",
      }).allowedOrigins,
    ).toEqual(["https://qman.example", "https://board.qman.example"]);

    // A path or a trailing slash never matches an Origin header, so it is
    // refused at startup rather than silently rejecting every request.
    expect(() =>
      loadConfig({ ...MINIMUM, QMAN_ALLOWED_ORIGINS: "https://qman.example/app" }),
    ).toThrow(/origin only/);
    expect(() => loadConfig({ ...MINIMUM, QMAN_ALLOWED_ORIGINS: "qman.example" })).toThrow(
      /not a URL/,
    );
  });
});

describe("migration loading", () => {
  it("finds the migrations that ship with the persistence package", () => {
    const migrations = loadMigrations(migrationsDirectory());
    expect(migrations.map((m) => m.name)).toEqual([
      "001_initial",
      "002_session_tokens",
      "003_login_throttle",
    ]);
    expect(migrations[0]!.sql).toContain("CREATE TABLE hospitals");
  });
});
