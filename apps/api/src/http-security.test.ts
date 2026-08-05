/**
 * Response headers and cross-origin access.
 *
 * Exercised through the whole server rather than the header helper, because
 * the property that matters is that they reach every response — including the
 * ones nobody remembers to test, like a 404 or an error.
 */
import { describe, expect, it } from "vitest";
import { AuthService, createMemoryLockoutStore } from "./auth.js";
import { buildServer } from "./server.js";
import type { AccountRepository, SessionRepository } from "@qman/persistence";

const ORIGIN = "https://qman.hospital.example";
const HOSPITAL = "11111111-1111-1111-1111-111111111111";

const accounts = {
  findByUsername: async () => null,
  findById: async () => null,
  updatePassword: async () => {},
} as unknown as AccountRepository;

const sessions = {
  find: async () => null,
  findByToken: async () => null,
  create: async () => {},
  activeForHospital: async () => [],
  save: async () => {},
  endAllForUser: async () => 0,
} as unknown as SessionRepository;

function server(overrides: { https?: boolean } = {}) {
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
    ...overrides,
  });
}

describe("security headers", () => {
  it("denies every fetch directive, since the API serves only JSON", async () => {
    const response = await server().inject({ method: "GET", url: "/api/health" });
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  /**
   * Responses carry patient names and hospital numbers, and the machines
   * running QMan are shared. Without this a list fetched at 9am can be served
   * from a cache to whoever sits down at 2pm.
   */
  it("forbids caching of every response", async () => {
    const response = await server().inject({ method: "GET", url: "/api/health" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("sets them on responses nobody tests, too", async () => {
    const missing = await server().inject({ method: "GET", url: "/api/nothing-here" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["x-content-type-options"]).toBe("nosniff");
    expect(missing.headers["cache-control"]).toBe("no-store");
  });

  /** Promising HSTS without HTTPS locks users out of a working server. */
  it("promises HSTS only where there is TLS to promise", async () => {
    const secure = await server({ https: true }).inject({ method: "GET", url: "/api/health" });
    expect(secure.headers["strict-transport-security"]).toContain("max-age=");

    const plain = await server({ https: false }).inject({ method: "GET", url: "/api/health" });
    expect(plain.headers["strict-transport-security"]).toBeUndefined();
  });
});

describe("cross-origin access", () => {
  it("echoes an allowed origin and permits credentials", async () => {
    const response = await server().inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: ORIGIN },
    });
    expect(response.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  /** A wildcard with credentials is refused by browsers outright. */
  it("never answers with a wildcard", async () => {
    const response = await server().inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: ORIGIN },
    });
    expect(response.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("says nothing to an origin it does not know", async () => {
    const response = await server().inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://malicious.example" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  /**
   * Without Vary, a cache can serve one origin's allow header to another —
   * turning a correct allow-list into an incorrect one at the caching layer.
   */
  it("varies on origin whether or not the origin matched", async () => {
    const known = await server().inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: ORIGIN },
    });
    const unknown = await server().inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://malicious.example" },
    });
    expect(known.headers["vary"]).toContain("Origin");
    expect(unknown.headers["vary"]).toContain("Origin");
  });

  /**
   * A preflight carries no credentials and no CSRF token. Answered before the
   * CSRF check, which would otherwise refuse it for having none.
   */
  it("answers a preflight without requiring a CSRF token", async () => {
    const response = await server().inject({
      method: "OPTIONS",
      url: "/api/v1/auth/login",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-csrf-token",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    expect(response.headers["access-control-allow-headers"]).toContain("x-csrf-token");
  });
});
