import { describe, expect, it } from "vitest";
import { ConfigurationError, loadConfig } from "./config.js";
import { loadMigrations, migrationsDirectory } from "./migrations.js";

const MINIMUM = {
  DATABASE_URL: "postgres://qman:secret@db.example:5432/qman",
  QMAN_ALLOWED_ORIGINS: "https://qman.hospital.example",
} satisfies NodeJS.ProcessEnv;

describe("configuration", () => {
  it("refuses to start without a database or allowed origins", () => {
    expect(() => loadConfig({})).toThrow(ConfigurationError);
    expect(() => loadConfig({ DATABASE_URL: MINIMUM.DATABASE_URL })).toThrow(
      /QMAN_ALLOWED_ORIGINS/,
    );
  });

  /**
   * The variable is refused rather than ignored.
   *
   * A deployment still setting it was configured under the belief that this
   * server serves one named hospital. That belief is now wrong, and ignoring
   * the variable would let the server run happily while its operator kept it.
   */
  it("refuses to start when the single-tenant hospital variable is still set", () => {
    expect(() =>
      loadConfig({ ...MINIMUM, QMAN_HOSPITAL_ID: "11111111-1111-1111-1111-111111111111" }),
    ).toThrow(/QMAN_HOSPITAL_ID/);
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

  /**
   * Production is the default posture. Assuming development unless told
   * otherwise would mean a deployment that forgot NODE_ENV runs with every one
   * of development's conveniences — each of which is a weakened control.
   */
  it("treats an unset NODE_ENV as production", () => {
    expect(loadConfig(MINIMUM).production).toBe(true);
    expect(loadConfig({ ...MINIMUM, NODE_ENV: "development" }).production).toBe(false);
  });

  /** In production Secure is not a default but a floor. */
  it("refuses to run in production without Secure cookies", () => {
    expect(loadConfig(MINIMUM).secureCookies).toBe(true);
    expect(() => loadConfig({ ...MINIMUM, QMAN_SECURE_COOKIES: "false" })).toThrow(
      /would be sent over plain HTTP/,
    );
  });

  /** http://localhost never receives a Secure cookie, so sign-in would fail. */
  it("defaults Secure off in development, where it would break sign-in", () => {
    const dev = loadConfig({ ...MINIMUM, NODE_ENV: "development" });
    expect(dev.secureCookies).toBe(false);
  });

  /**
   * A developer should not have to configure CORS before the server will
   * start; a production deployment must not be able to skip it.
   */
  it("defaults allowed origins in development only", () => {
    const { QMAN_ALLOWED_ORIGINS: _omitted, ...without } = MINIMUM;
    const dev = loadConfig({ ...without, NODE_ENV: "development" });
    expect(dev.allowedOrigins).toContain("http://localhost:5173");

    expect(() => loadConfig(without)).toThrow(/no default in production/);
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

  it("keeps development defaults out of production", () => {
    expect(loadConfig(MINIMUM).allowedOrigins).toEqual(["https://qman.hospital.example"]);
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
      "004_idempotency",
      "005_tracking_tokens",
      "006_deferred_current_entry",
      "007_platform_users",
      "008_platform_sessions",
      "009_platform_events",
      "010_platform_login_throttle",
      "011_organization_lifecycle",
      "012_administrative_events_have_no_branch",
    ]);
    expect(migrations[0]!.sql).toContain("CREATE TABLE hospitals");
  });
});
