/**
 * Configuration writes.
 *
 * Driven over HTTP against a real transaction fake, because the properties that
 * matter are not "does the field change" but "what happens when it must not":
 * a rejected change writes nothing including its audit entry, a caller without
 * the permission gets no further than the guard, and every accepted change
 * leaves an entry naming who did it and what it was before.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { FakeDatabase } from "@qman/persistence";
import { AuthService, createMemoryLockoutStore } from "./auth.js";
import { ConfigurationService } from "./configuration-service.js";
import { buildServer } from "./server.js";
import { silentLogger } from "./logging.js";
import {
  account,
  configuration,
  credentialsFrom,
  FakeAccounts,
  FakeConfiguration,
  FakeSessions,
  HOSPITAL,
  ORIGIN,
  PASSWORD,
  primeConfigurationRead,
  RecordingWriter,
  STATION,
} from "./config-fixtures.js";

describe("configuration writes", () => {
  let accounts: FakeAccounts;
  let sessions: FakeSessions;
  let db: FakeDatabase;
  let writer: RecordingWriter;

  function server() {
    return buildServer({
      auth: new AuthService({
        accounts,
        sessions,
        lockouts: createMemoryLockoutStore(),
        now: () => new Date("2026-03-09T09:00:00Z"),
        newId: () => "session-1",
      }),
      resolveHospital: () => HOSPITAL,
      secureCookies: true,
      allowedOrigins: [ORIGIN],
      logger: silentLogger(),
      configuration: { configuration: new FakeConfiguration() },
      configurationWrites: {
        service: new ConfigurationService({
          db,
          writer,
          now: () => new Date("2026-03-09T09:00:00Z"),
        }),
        writer,
      },
    });
  }

  async function signIn(app: ReturnType<typeof server>) {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { username: "adaeze", password: PASSWORD },
    });
    return credentialsFrom(login.headers["set-cookie"]);
  }

  beforeEach(() => {
    accounts = new FakeAccounts();
    sessions = new FakeSessions();
    db = new FakeDatabase();
    writer = new RecordingWriter();
  });

  it("applies a valid station change and persists only that entity", async () => {
    accounts.accounts.push(await account(["admin.stations"]));
    const app = server();
    const { cookie, csrf } = await signIn(app);
    primeConfigurationRead(db, configuration());

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/stations/${STATION}`,
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      payload: { sla: { targetWaitMillis: 900_000, saturationPoint: 15 } },
    });

    expect(response.statusCode).toBe(200);
    expect(writer.stations).toHaveLength(1);
    expect(writer.stations[0]!.sla.targetWaitMillis).toBe(900_000);
    expect(writer.others).toEqual([]);
  });

  /** A field absent from the patch must be left alone, not overwritten. */
  it("leaves fields the patch does not mention", async () => {
    accounts.accounts.push(await account(["admin.stations"]));
    const app = server();
    const { cookie, csrf } = await signIn(app);
    primeConfigurationRead(db, configuration());

    await app.inject({
      method: "PATCH",
      url: `/api/v1/stations/${STATION}`,
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      payload: { name: "Consultation A" },
    });

    const saved = writer.stations[0]!;
    expect(saved.name).toBe("Consultation A");
    expect(saved.room).toBe("Room 12");
    expect(saved.sla.targetWaitMillis).toBe(1_200_000);
  });

  /**
   * The property the whole design exists for: a change the domain rejects
   * writes nothing at all — not the entity, and not an audit entry claiming it
   * happened.
   */
  it("writes nothing when the domain rejects the result", async () => {
    accounts.accounts.push(await account(["admin.stations"]));
    const app = server();
    const { cookie, csrf } = await signIn(app);
    primeConfigurationRead(db, configuration());

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/stations/${STATION}`,
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      // An empty name is an error in validateHospitalConfiguration.
      payload: { name: "   " },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().problems.length).toBeGreaterThan(0);
    expect(writer.stations).toEqual([]);
    expect(db.matching("INSERT INTO events")).toHaveLength(0);
  });

  it("reports the domain's problems so a screen can point at the field", async () => {
    accounts.accounts.push(await account(["admin.stations"]));
    const app = server();
    const { cookie, csrf } = await signIn(app);
    primeConfigurationRead(db, configuration());

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/stations/${STATION}`,
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      payload: { name: "" },
    });

    const problems = response.json().problems as Array<{ path: string; severity: string }>;
    expect(problems.every((problem) => problem.severity === "error")).toBe(true);
    expect(problems[0]!.path).toContain("stations");
  });

  describe("audit", () => {
    it("records who changed what, from what, to what", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeConfigurationRead(db, configuration());

      await app.inject({
        method: "PATCH",
        url: `/api/v1/stations/${STATION}`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { sla: { targetWaitMillis: 900_000, saturationPoint: 15 } },
      });

      const [entry] = db.matching("INSERT INTO events");
      expect(entry).toBeDefined();

      const params = entry!.params;
      const payload = JSON.parse(params.find((p) => typeof p === "string" && p.includes("before")) as string);
      expect(payload.before.targetWaitMillis).toBe(1_200_000);
      expect(payload.after.targetWaitMillis).toBe(900_000);
      expect(payload.path).toBe(`stations.${STATION}.sla`);
      expect(payload.requestId).toBeDefined();
      expect(params).toContain("aaaaaaaa-0000-0000-0000-000000000001");
      expect(params).toContain(HOSPITAL);
    });

    /**
     * "Who changed this SLA" is the question asked months later. An entry
     * saying only "a station was updated" cannot answer it.
     */
    it("names the specific change rather than the entity", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeConfigurationRead(db, configuration());

      await app.inject({
        method: "PATCH",
        url: `/api/v1/stations/${STATION}`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { queueNumber: { template: "OPD-{n:4}", reset: "daily", manualEpoch: null } },
      });

      const [entry] = db.matching("INSERT INTO events");
      expect(entry!.params).toContain("config.queue_numbering_updated");
      expect(entry!.params.some((p) => typeof p === "string" && p.includes("OPD-{n:4}"))).toBe(
        true,
      );
    });

    /** Administrative records group by sitting, not by patient. */
    it("correlates the entry by session", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeConfigurationRead(db, configuration());

      await app.inject({
        method: "PATCH",
        url: `/api/v1/stations/${STATION}`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { name: "Consultation B" },
      });

      const [entry] = db.matching("INSERT INTO events");
      expect(entry!.params).toContain("session-1");
      expect(entry!.params).toContain("administrative");
    });

    /** The whole change lands in one transaction, audit included. */
    it("writes the entity and its audit entry in the same unit of work", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeConfigurationRead(db, configuration());

      await app.inject({
        method: "PATCH",
        url: `/api/v1/stations/${STATION}`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { name: "Consultation C" },
      });

      expect(db.committed).toHaveLength(1);
      expect(db.matching("INSERT INTO events")).toHaveLength(1);
    });
  });

  describe("permissions", () => {
    it("refuses a station change without admin.stations", async () => {
      accounts.accounts.push(await account(["admin.workflows"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/stations/${STATION}`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { name: "Nope" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().permission).toBe("admin.stations");
      expect(writer.stations).toEqual([]);
    });

    it("requires a separate permission for each kind of configuration", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);

      for (const [url, permission] of [
        ["/api/v1/workflows/w1", "admin.workflows"],
        ["/api/v1/display-boards/b1", "admin.display_boards"],
        ["/api/v1/profile", "admin.settings"],
        ["/api/v1/settings", "admin.settings"],
      ] as const) {
        const response = await app.inject({
          method: "PATCH",
          url,
          headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
          payload: {},
        });
        expect(response.json().permission).toBe(permission);
      }
    });

    it("refuses an unauthenticated write before reading anything", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const response = await server().inject({
        method: "PATCH",
        url: `/api/v1/stations/${STATION}`,
        headers: { origin: ORIGIN },
        payload: { name: "Nope" },
      });

      expect(response.statusCode).toBe(401);
      expect(db.statements).toEqual([]);
    });
  });
});
