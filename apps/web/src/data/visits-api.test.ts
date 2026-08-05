import { describe, expect, it } from "vitest";
import { ApiClient } from "../api/client.js";
import { VisitsApi } from "./visits-api.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
  idempotencyKey: string | undefined;
}

function stub(responses: Array<{ status: number; body?: unknown }> = []) {
  const calls: Call[] = [];
  const queue = [...responses];

  const client = new ApiClient({
    baseUrl: "https://api.qman.example",
    readCookies: () => "qman_csrf=token-abc",
    fetch: (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body === undefined ? undefined : JSON.parse(init.body as string),
        idempotencyKey: headers["Idempotency-Key"],
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

  return { api: new VisitsApi(client), calls };
}

describe("visits client", () => {
  it("reads a branch's visits and a station's queue", async () => {
    const { api, calls } = stub([
      { status: 200, body: { visits: [] } },
      { status: 200, body: { visits: [] } },
    ]);

    await api.listForBranch("branch-1");
    await api.listForStation("station-1");

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.qman.example/api/v1/branches/branch-1/visits",
      "https://api.qman.example/api/v1/stations/station-1/queue",
    ]);
  });

  it("sends each queue action to its own endpoint", async () => {
    const { api, calls } = stub(Array.from({ length: 6 }, () => ({ status: 200, body: {} })));

    await api.call("v1", "k");
    await api.recall("v1", "k");
    await api.start("v1", "k");
    await api.skip("v1", "k");
    await api.complete("v1", "k");
    await api.cancel("v1", "k");

    expect(calls.map((c) => c.url.split("/").pop())).toEqual([
      "call",
      "recall",
      "start",
      "skip",
      "complete",
      "cancel",
    ]);
    expect(calls.every((c) => c.method === "POST")).toBe(true);
  });

  /**
   * The reason the key exists: a retry the server cannot recognise turns a call
   * into a recall, announcing the patient twice and recording something nobody
   * did. The caller owns the key so a retry carries the same one.
   */
  it("carries the caller's idempotency key on every action", async () => {
    const { api, calls } = stub([
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);

    await api.call("v1", "the-same-key");
    await api.call("v1", "the-same-key");

    expect(calls.map((c) => c.idempotencyKey)).toEqual(["the-same-key", "the-same-key"]);
  });

  it("admits a patient and returns the tracking token once", async () => {
    const { api, calls } = stub([
      { status: 201, body: { visit: { state: {} }, trackingToken: "tok" } },
    ]);

    const result = await api.admit({ patientName: "Amara Okafor" }, "k");

    expect(calls[0]!.url).toBe("https://api.qman.example/api/v1/visits");
    expect(calls[0]!.body).toEqual({ patientName: "Amara Okafor" });
    expect(result.trackingToken).toBe("tok");
  });

  /**
   * Sent explicitly rather than inferred. The server refuses an off-workflow
   * route without the permission for it, and it can only do that if the caller
   * says which kind of route this is.
   */
  it("states whether a route followed the workflow", async () => {
    const { api, calls } = stub([
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);

    await api.route("v1", "station-lab", true, "k");
    await api.route("v1", "station-lab", false, "k");

    expect(calls[0]!.body).toEqual({ stationId: "station-lab", followedWorkflow: true });
    expect(calls[1]!.body).toEqual({ stationId: "station-lab", followedWorkflow: false });
  });

  it("escapes identifiers rather than pasting them into a path", async () => {
    const { api, calls } = stub([{ status: 200, body: {} }]);
    await api.call("v 1/../admin", "k");
    expect(calls[0]!.url).toBe(
      "https://api.qman.example/api/v1/visits/v%201%2F..%2Fadmin/call",
    );
  });
});
