import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "./client.js";

interface Call {
  url: string;
  init: RequestInit;
}

function stub(
  responses: Array<{ status: number; body?: unknown; json?: boolean }>,
  cookies = "",
) {
  const calls: Call[] = [];
  const queue = [...responses];

  const client = new ApiClient({
    baseUrl: "https://api.qman.example",
    readCookies: () => cookies,
    newKey: () => "generated-key",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = queue.shift() ?? { status: 200, body: {} };
      const isJson = next.json ?? true;
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        headers: {
          get: () => (isJson ? "application/json; charset=utf-8" : "text/html"),
        },
        json: async () => next.body,
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch,
  });

  return { client, calls };
}

describe("api client", () => {
  it("sends cookies, without which every request is silently anonymous", async () => {
    const { client, calls } = stub([{ status: 200, body: { ok: true } }]);
    await client.get("/api/v1/auth/me");
    expect(calls[0]!.init.credentials).toBe("include");
  });

  it("targets the configured API rather than the page's own origin", async () => {
    const { client, calls } = stub([{ status: 200, body: {} }]);
    await client.get("/api/v1/auth/me");
    expect(calls[0]!.url).toBe("https://api.qman.example/api/v1/auth/me");
  });

  /**
   * The session cookie is HttpOnly and unreadable here. The CSRF cookie is
   * readable precisely so it can be echoed into a header a cross-site page
   * cannot produce.
   */
  it("echoes the CSRF cookie on state-changing requests", async () => {
    const { client, calls } = stub(
      [{ status: 200, body: {} }],
      "other=x; qman_csrf=token-abc; more=y",
    );
    await client.post("/api/v1/visits/v1/call");
    expect((calls[0]!.init.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "token-abc",
    );
  });

  it("does not send a CSRF token or idempotency key on a read", async () => {
    const { client, calls } = stub([{ status: 200, body: {} }], "qman_csrf=token-abc");
    await client.get("/api/v1/auth/me");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBeUndefined();
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  /** Sign-in happens before any CSRF cookie exists, and must still work. */
  it("omits the CSRF header when no cookie has been set yet", async () => {
    const { client, calls } = stub([{ status: 200, body: {} }], "");
    await client.post("/api/v1/auth/login", { username: "ifeoma" });
    expect((calls[0]!.init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
  });

  /**
   * The reason the key exists: a retry the server cannot recognise turns a
   * call into a recall, announcing the patient twice.
   */
  it("carries the same idempotency key across retries of one action", async () => {
    const { client, calls } = stub([{ status: 200, body: {} }, { status: 200, body: {} }]);
    const key = client.newIdempotencyKey();

    await client.post("/api/v1/visits/v1/call", undefined, key);
    await client.post("/api/v1/visits/v1/call", undefined, key);

    const first = (calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"];
    const second = (calls[1]!.init.headers as Record<string, string>)["Idempotency-Key"];
    expect(first).toBe(second);
  });

  it("gives distinct keys to distinct actions", () => {
    // The real generator, not the fixed one the request stub uses.
    const client = new ApiClient({ baseUrl: "", readCookies: () => "" });
    const keys = new Set(Array.from({ length: 50 }, () => client.newIdempotencyKey()));
    expect(keys.size).toBe(50);
  });

  describe("failures", () => {
    /**
     * These are different situations for a receptionist. Collapsing them into
     * one message makes the screen unhelpful exactly when it matters.
     */
    it("distinguishes the failures that change what a user should do", async () => {
      const cases = [
        { status: 401, failure: "unauthenticated" },
        { status: 403, failure: "forbidden" },
        { status: 404, failure: "not_found" },
        { status: 409, failure: "conflict" },
        { status: 429, failure: "rate_limited" },
        { status: 500, failure: "server" },
      ] as const;

      for (const { status, failure } of cases) {
        const { client } = stub([{ status, body: { error: "no" } }]);
        await expect(client.get("/api/v1/x")).rejects.toMatchObject({ failure });
      }
    });

    it("reports a network failure as offline rather than as a server error", async () => {
      const client = new ApiClient({
        baseUrl: "",
        readCookies: () => "",
        fetch: (() => Promise.reject(new TypeError("Failed to fetch"))) as never,
      });

      await expect(client.get("/api/v1/auth/me")).rejects.toMatchObject({
        failure: "offline",
        status: 0,
      });
    });

    it("marks only offline and server failures as worth retrying", async () => {
      expect(new ApiError("offline", "", 0).retryable).toBe(true);
      expect(new ApiError("server", "", 500).retryable).toBe(true);
      expect(new ApiError("forbidden", "", 403).retryable).toBe(false);
      expect(new ApiError("conflict", "", 409).retryable).toBe(false);
    });

    it("carries the server's message, named permission and request id", async () => {
      const { client } = stub([
        {
          status: 403,
          body: {
            error: "You do not have permission to do that.",
            permission: "queue.call",
            requestId: "req-123",
          },
        },
      ]);

      await expect(client.get("/api/v1/x")).rejects.toMatchObject({
        message: "You do not have permission to do that.",
        permission: "queue.call",
        requestId: "req-123",
      });
    });

    /** A proxy error page is not an API response and must not be parsed as one. */
    it("handles a non-JSON error body without throwing something unrecognisable", async () => {
      const { client } = stub([{ status: 502, json: false }]);
      await expect(client.get("/api/v1/x")).rejects.toBeInstanceOf(ApiError);
    });

    it("treats 204 as success with no body", async () => {
      const { client } = stub([{ status: 204 }]);
      await expect(client.post("/api/v1/auth/logout")).resolves.toBeUndefined();
    });
  });
});
