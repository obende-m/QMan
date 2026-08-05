/**
 * Creating and deleting configuration.
 *
 * Deletion carries the risk here, so most of these are about refusal. A station
 * that has served patients cannot be removed without taking their queue entries
 * with it, and those entries are the record of people who were actually seen.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TICKET_TEMPLATE, type HospitalConfiguration, type RoleConfig } from "@qman/domain";
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
  primeRolesRead,
  RecordingWriter,
  STATION,
  stationConfig,
  WORKFLOW,
} from "./config-fixtures.js";

const ADMINISTRATOR: RoleConfig = {
  id: "role-admin",
  name: "Administrator",
  description: "",
  permissions: ["admin.users"],
  isSystem: true,
};

describe("configuration lifecycle", () => {
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

  describe("creation", () => {
    it("creates a station and records it as added", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeConfigurationRead(db, configuration());

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stations",
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: {
          name: "Pharmacy",
          code: "PHR",
          sla: { targetWaitMillis: 900_000, saturationPoint: 10 },
          queueNumber: { template: "P-{n:3}", reset: "daily" },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(writer.created).toEqual(["station"]);
      expect(writer.stations[0]!.name).toBe("Pharmacy");
      expect(db.matching("INSERT INTO events")[0]!.params).toContain("config.station_added");
    });

    /**
     * A client choosing its own identifier could collide with an existing row,
     * or resurrect a deleted one and inherit its history.
     */
    it("mints the identifier rather than accepting one", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeConfigurationRead(db, configuration());

      await app.inject({
        method: "POST",
        url: "/api/v1/stations",
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { id: STATION, name: "Impostor", code: "IMP" },
      });

      expect(writer.stations[0]!.id).not.toBe(STATION);
      expect(writer.stations[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    /** Showing names must be a decision, never a default a board is born with. */
    it("creates a display board at the most private name policy", async () => {
      accounts.accounts.push(await account(["admin.display_boards"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeConfigurationRead(db, configuration());

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/display-boards",
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { name: "Main Waiting Area", stationIds: [STATION] },
      });

      expect(response.statusCode).toBe(200);
      const boards = response.json().configuration.displayBoards;
      expect(boards[boards.length - 1].namePolicy).toBe("ticket_only");
    });

    it("refuses a creation that would make the configuration invalid", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeConfigurationRead(db, configuration());

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/stations",
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { name: "", code: "" },
      });

      expect(response.statusCode).toBe(422);
      expect(writer.created).toEqual([]);
      expect(db.matching("INSERT INTO events")).toHaveLength(0);
    });
  });

  describe("deletion", () => {
    it("deletes a station nothing refers to", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);

      const spare = stationConfig({
        id: "55555555-5555-5555-5555-555555555555",
        code: "SPR",
        name: "Spare",
      } as never);
      const config = configuration();
      primeConfigurationRead(db, {
        ...config,
        stations: [...config.stations, spare],
      } as HospitalConfiguration);

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/stations/55555555-5555-5555-5555-555555555555`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      });

      expect(response.statusCode).toBe(200);
      expect(writer.deleted).toEqual(["station"]);
    });

    /**
     * The refusal that matters. Attempting the delete would be safe — the
     * database restricts it — but the caller receives a constraint violation as
     * a 500, and an administrator learns nothing about what to do instead.
     */
    it("refuses to delete a station still in use, and says what uses it", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      writer.usage = [
        { singular: "workflow stage", plural: "workflow stages", count: 2 },
        { singular: "queue entry", plural: "queue entries", count: 40 },
      ];
      primeConfigurationRead(db, configuration());

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/stations/${STATION}`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      });

      expect(response.statusCode).toBe(422);
      const [problem] = response.json().problems;
      expect(problem.message).toContain("2 workflow stages");
      expect(problem.message).toContain("40 queue entries");
      expect(problem.message).toContain("Disable the station instead");
      expect(writer.deleted).toEqual([]);
      expect(db.matching("INSERT INTO events")).toHaveLength(0);
    });

    it("refuses to delete a workflow that visits were routed through", async () => {
      accounts.accounts.push(await account(["admin.workflows"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      writer.usage = [{ singular: "visit", plural: "visits", count: 1 }];
      primeConfigurationRead(db, configuration());

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/workflows/${WORKFLOW}`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().problems[0].message).toContain("1 visit");
      expect(writer.deleted).toEqual([]);
    });

    /** The domain already requires the default template to exist. */
    it("refuses to delete the default ticket template", async () => {
      accounts.accounts.push(await account(["admin.settings"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeConfigurationRead(db, configuration());

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/ticket-templates/${DEFAULT_TICKET_TEMPLATE.id}`,
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      });

      expect(response.statusCode).toBe(422);
      expect(writer.deleted).toEqual([]);
    });

    it("records a deletion with the value that was removed", async () => {
      accounts.accounts.push(await account(["admin.display_boards"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      const config = configuration();
      primeConfigurationRead(db, {
        ...config,
        displayBoards: [
          {
            id: "board-1",
            name: "Main Waiting Area",
            stationIds: [STATION],
            waitingToShow: 4,
            namePolicy: "ticket_only",
            showEstimatedWait: true,
            showRoom: true,
          },
        ],
      } as unknown as HospitalConfiguration);

      await app.inject({
        method: "DELETE",
        url: "/api/v1/display-boards/board-1",
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      });

      const [entry] = db.matching("INSERT INTO events");
      const payload = JSON.parse(
        entry!.params.find((p) => typeof p === "string" && p.includes("before")) as string,
      );
      expect(payload.before.name).toBe("Main Waiting Area");
      expect(payload.after).toBeNull();
    });
  });

  describe("roles", () => {
    it("creates a role, and never as a system role", async () => {
      accounts.accounts.push(await account(["admin.users"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeRolesRead(db, [ADMINISTRATOR]);

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { name: "Pharmacist", permissions: ["queue.call"], isSystem: true },
      });

      expect(response.statusCode).toBe(200);
      expect(writer.created).toEqual(["role"]);
      expect(db.matching("INSERT INTO events")[0]!.params).toContain("config.role_created");
      // Requested as a system role and created as an ordinary one: otherwise a
      // hospital could manufacture roles it cannot delete.
      expect(writer.roles[0]!.isSystem).toBe(false);
    });

    /**
     * The catastrophe this prevents: a hospital editing its way to having no
     * role that can manage users, and locking every administrator out with no
     * route back in through the product.
     */
    it("refuses a change that would leave nobody able to administer", async () => {
      accounts.accounts.push(await account(["admin.users"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeRolesRead(db, [ADMINISTRATOR]);

      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/roles/role-admin",
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { permissions: ["queue.call"] },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().problems[0].message).toContain("administer");
      expect(writer.others).toEqual([]);
      expect(db.matching("INSERT INTO events")).toHaveLength(0);
    });

    it("records a permission grant on both sides", async () => {
      accounts.accounts.push(await account(["admin.users"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeRolesRead(db, [
        ADMINISTRATOR,
        { id: "role-nurse", name: "Nurse", description: "", permissions: [], isSystem: false },
      ]);

      await app.inject({
        method: "PATCH",
        url: "/api/v1/roles/role-nurse",
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        payload: { permissions: ["queue.call", "queue.recall"] },
      });

      const [entry] = db.matching("INSERT INTO events");
      expect(entry!.params).toContain("config.role_updated");
      const payload = JSON.parse(
        entry!.params.find((p) => typeof p === "string" && p.includes("before")) as string,
      );
      expect(payload.before).toEqual([]);
      expect(payload.after).toEqual(["queue.call", "queue.recall"]);
    });

    it("refuses to delete a role that users still hold", async () => {
      accounts.accounts.push(await account(["admin.users"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      writer.usage = [{ singular: "user", plural: "users", count: 3 }];
      primeRolesRead(db, [
        ADMINISTRATOR,
        { id: "role-nurse", name: "Nurse", description: "", permissions: [], isSystem: false },
      ]);

      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/roles/role-nurse",
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().problems[0].message).toContain("3 users");
      expect(writer.deleted).toEqual([]);
    });

    it("deletes a role nobody holds", async () => {
      accounts.accounts.push(await account(["admin.users"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);
      primeRolesRead(db, [
        ADMINISTRATOR,
        { id: "role-nurse", name: "Nurse", description: "", permissions: [], isSystem: false },
      ]);

      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/roles/role-nurse",
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
      });

      expect(response.statusCode).toBe(200);
      expect(writer.deleted).toEqual(["role"]);
      expect(db.matching("INSERT INTO events")[0]!.params).toContain("config.role_deleted");
    });

    it("requires admin.users for every role operation", async () => {
      accounts.accounts.push(await account(["admin.stations"]));
      const app = server();
      const { cookie, csrf } = await signIn(app);

      for (const [method, url] of [
        ["POST", "/api/v1/roles"],
        ["PATCH", "/api/v1/roles/role-1"],
        ["DELETE", "/api/v1/roles/role-1"],
      ] as const) {
        const response = await app.inject({
          method,
          url,
          headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
          payload: {},
        });
        expect(response.json().permission).toBe("admin.users");
      }
    });
  });
});
