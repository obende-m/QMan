/**
 * The configuration client.
 *
 * What is worth testing here is the contract, not the plumbing: that reads and
 * writes go to the versioned paths, that writes use the methods the server
 * guards, and that a rejected change surfaces the domain's problems rather than
 * a flattened message. The transport itself is covered in `client.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "../api/client.js";
import { ConfigurationApi } from "./configuration-api.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stub(responses: Array<{ status: number; body?: unknown }> = []) {
  const calls: Call[] = [];
  const queue = [...responses];

  const client = new ApiClient({
    baseUrl: "https://api.qman.example",
    readCookies: () => "qman_csrf=token-abc",
    newKey: () => "key-1",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body === undefined ? undefined : JSON.parse(init.body as string),
      });
      const next = queue.shift() ?? { status: 200, body: {} };
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        headers: { get: () => "application/json" },
        json: async () => next.body,
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch,
  });

  return { api: new ConfigurationApi(client), calls };
}

describe("configuration client", () => {
  it("reads the configuration from the versioned path", async () => {
    const { api, calls } = stub([
      { status: 200, body: { configuration: { profile: { name: "Ikeja" } }, problems: [] } },
    ]);

    const snapshot = await api.read();

    expect(calls[0]!.url).toBe("https://api.qman.example/api/v1/config");
    expect(calls[0]!.method).toBe("GET");
    expect(snapshot.configuration.profile.name).toBe("Ikeja");
  });

  /**
   * Returned with the configuration rather than recomputed here. A copy of the
   * domain's validation in the browser would be a second opinion, and it would
   * win every disagreement by answering first and without a network.
   */
  it("takes the problems from the server rather than computing them", async () => {
    const { api } = stub([
      {
        status: 200,
        body: {
          configuration: {},
          problems: [{ path: "stations", message: "At least one station.", severity: "error" }],
        },
      },
    ]);

    const snapshot = await api.read();
    expect(snapshot.problems[0]!.message).toBe("At least one station.");
  });

  it("sends each write with the method its route is registered under", async () => {
    const { api, calls } = stub([
      { status: 200, body: {} },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);

    await api.createStation({ name: "Pharmacy" });
    await api.updateStation("st-1", { name: "Pharmacy A" });
    await api.deleteStation("st-1");

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "https://api.qman.example/api/v1/stations"],
      ["PATCH", "https://api.qman.example/api/v1/stations/st-1"],
      ["DELETE", "https://api.qman.example/api/v1/stations/st-1"],
    ]);
  });

  it("escapes an identifier rather than pasting it into a path", async () => {
    const { api, calls } = stub([{ status: 200, body: {} }]);
    await api.updateStation("st 1/../admin", {});
    expect(calls[0]!.url).toBe(
      "https://api.qman.example/api/v1/stations/st%201%2F..%2Fadmin",
    );
  });

  it("sends only the fields a patch carries", async () => {
    const { api, calls } = stub([{ status: 200, body: {} }]);
    await api.updateStation("st-1", { sla: { targetWaitMillis: 900_000 } });
    expect(calls[0]!.body).toEqual({ sla: { targetWaitMillis: 900_000 } });
  });

  it("routes the hospital defaults to settings, not to a privacy endpoint", async () => {
    const { api, calls } = stub([{ status: 200, body: {} }]);
    await api.updateDefaults({ namePolicy: "first_name" });
    expect(calls[0]!.url).toBe("https://api.qman.example/api/v1/settings");
  });

  /**
   * A rejection is not a server fault. It is not retryable — the same request
   * is refused for the same reason — and it carries the problems a form marks
   * its fields with.
   */
  it("surfaces a rejected write with the fields that failed", async () => {
    const { api } = stub([
      {
        status: 422,
        body: {
          error: "That change is not valid.",
          problems: [{ path: "stations.st-1", message: "Needs a name.", severity: "error" }],
        },
      },
    ]);

    const failure = await api.updateStation("st-1", { name: "" }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).failure).toBe("rejected");
    expect((failure as ApiError).retryable).toBe(false);
    expect((failure as ApiError).problems[0]!.path).toBe("stations.st-1");
  });

  it("reads and writes roles through their own routes", async () => {
    const { api, calls } = stub([
      { status: 200, body: { roles: [] } },
      { status: 200, body: { roles: [] } },
      { status: 200, body: { roles: [] } },
      { status: 200, body: { roles: [] } },
    ]);

    await api.roles();
    await api.createRole({ name: "Pharmacist", permissions: [] });
    await api.updateRole("role-1", { permissions: [] });
    await api.deleteRole("role-1");

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "https://api.qman.example/api/v1/roles"],
      ["POST", "https://api.qman.example/api/v1/roles"],
      ["PATCH", "https://api.qman.example/api/v1/roles/role-1"],
      ["DELETE", "https://api.qman.example/api/v1/roles/role-1"],
    ]);
  });
});
