/**
 * The HTTP surface.
 *
 * Built as a function of its dependencies rather than assembled from module
 * scope, so a test constructs a whole server over fake repositories and drives
 * it through `inject` — no port, no database, no network. What that buys is
 * that the security rules below are covered by ordinary unit tests rather than
 * by a manual pass someone does before a release.
 *
 * Routes are named for what the hospital does, not for the tables underneath.
 * The domain has a vocabulary — call, route, complete, recall — and an API of
 * `PATCH /queue_entries/:id` would discard it, pushing the state machine's
 * rules back out to every caller that has to know which field to set.
 *
 * An unsafe request passes four independent controls before it reaches a
 * handler: it must come from a known origin, carry a CSRF token it could only
 * have read from its own cookie, belong to a live session, and hold the
 * permission the route declares. None of them is sufficient alone.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser, Session } from "@qman/domain";
import type { AuthService } from "./auth.js";
import {
  readSessionToken,
  requirePermission,
  requireSignedIn,
  SESSION_COOKIE,
  type GuardDependencies,
} from "./authorization.js";
import { CSRF_COOKIE, issueCsrfToken, verifyCsrf } from "./csrf.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import { silentLogger, type Logger } from "./logging.js";
import { applyCors, handlePreflight, securityHeaders } from "./http-security.js";
import { registerQueueRoutes, type QueueRouteDependencies } from "./queue-routes.js";
import { EventStream, formatHeartbeat, HEARTBEAT_MILLIS } from "./stream.js";
import { registerPublicRoutes, type PublicRouteDependencies } from "./public-routes.js";
import { registerConfigRoutes, type ConfigRouteDependencies } from "./config-routes.js";
import { registerConfigWriteRoutes, type ConfigWriteDependencies } from "./config-write-routes.js";
import { V1 } from "./version.js";

export { SESSION_COOKIE };
export { CSRF_COOKIE, CSRF_HEADER } from "./csrf.js";

export interface ServerOptions {
  readonly auth: AuthService;
  readonly logger?: Logger;
  /**
   * Which hospital a request belongs to.
   *
   * A function rather than a constant because the tenant boundary is real even
   * while there is one tenant: a single-hospital deployment answers with its
   * configured id, and a hosted one will read a subdomain. Nothing downstream
   * changes when that happens.
   */
  readonly resolveHospital: (request: FastifyRequest) => string;
  /**
   * Whether to mark cookies Secure. False only for plain-HTTP local
   * development — a Secure cookie is never sent over HTTP, so leaving it on
   * would make sign-in silently fail on a developer's machine.
   */
  readonly secureCookies: boolean;
  /** Origins permitted to make unsafe requests. The three QMan surfaces. */
  readonly allowedOrigins: readonly string[];
  readonly rateLimiter?: RateLimiter;
  readonly now?: () => Date;
  /** Set when the deployment terminates TLS. Controls HSTS only. */
  readonly https?: boolean;
  readonly stream?: EventStream;
  /** The configuration read. Registered only when its repository exists. */
  readonly configuration?: Omit<ConfigRouteDependencies, "guards" | "logger" | "resolveHospital">;
  /** Configuration writes. Registered only when the service exists. */
  readonly configurationWrites?: Omit<
    ConfigWriteDependencies,
    "guards" | "logger" | "resolveHospital"
  >;
  /** The two unauthenticated surfaces. Registered only when configured. */
  readonly publicSurfaces?: Omit<PublicRouteDependencies, "logger" | "now">;
  /** Business routes are registered only when their repositories exist. */
  readonly queue?: Omit<QueueRouteDependencies, "guards" | "logger" | "resolveHospital" | "stream">;
}

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
    authenticated?: { user: AuthenticatedUser; session: Session; hospitalId: string };
  }
}

interface Credentials {
  username?: unknown;
  password?: unknown;
  branchId?: unknown;
}

interface CookieOptions {
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly maxAge?: number;
}

function cookie(name: string, value: string, options: CookieOptions): string {
  const attributes = [`${name}=${encodeURIComponent(value)}`, "Path=/"];
  // Unreadable from JavaScript, so a script injected into any surface cannot
  // read the session out of document.cookie. The CSRF cookie is deliberately
  // the exception: the application's own code has to read it to echo it back.
  if (options.httpOnly) attributes.push("HttpOnly");
  // Lax rather than Strict: the display board and patient tracker are opened
  // from links and QR codes, and Strict would drop the cookie on arrival. Lax
  // still withholds it from cross-site POSTs, which is the attack.
  attributes.push("SameSite=Lax");
  if (options.secure) attributes.push("Secure");
  if (options.maxAge !== undefined) attributes.push(`Max-Age=${options.maxAge}`);
  return attributes.join("; ");
}

function startSession(reply: FastifyReply, token: string, csrf: string, secure: boolean): void {
  void reply.header("Set-Cookie", [
    cookie(SESSION_COOKIE, token, { secure, httpOnly: true }),
    cookie(CSRF_COOKIE, csrf, { secure, httpOnly: false }),
  ]);
}

function endSessionCookies(reply: FastifyReply, secure: boolean): void {
  void reply.header("Set-Cookie", [
    cookie(SESSION_COOKIE, "", { secure, httpOnly: true, maxAge: 0 }),
    cookie(CSRF_COOKIE, "", { secure, httpOnly: false, maxAge: 0 }),
  ]);
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const logger = options.logger ?? silentLogger();
  const now = options.now ?? (() => new Date());
  const rateLimiter = options.rateLimiter ?? createRateLimiter();
  const stream = options.stream ?? new EventStream();
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  const guards: GuardDependencies = {
    auth: options.auth,
    logger,
    resolveHospital: options.resolveHospital,
  };

  /**
   * One identifier per request, minted here or adopted from a proxy that
   * already made one. Adopting it keeps a hospital's reverse proxy logs and
   * these logs describing the same request.
   */
  app.addHook("onRequest", async (request) => {
    const supplied = request.headers["x-request-id"];
    request.requestId =
      typeof supplied === "string" && supplied.length > 0 && supplied.length <= 128
        ? supplied
        : randomUUID();
  });

  /**
   * Headers are set on every response, including errors and 404s. Attaching
   * them per-route would leave exactly the responses nobody remembers to test
   * without them.
   */
  const headers = securityHeaders({ https: options.https ?? options.secureCookies });
  app.addHook("onRequest", async (request, reply) => {
    for (const [name, value] of Object.entries(headers)) void reply.header(name, value);
    applyCors(request, reply, options.allowedOrigins);

    // A preflight carries no credentials and must be answered before the CSRF
    // check, which would refuse it for having no token.
    if (handlePreflight(request, reply, options.allowedOrigins)) return reply;
    return undefined;
  });

  /**
   * CSRF runs before anything reads the body, so a forged request is refused
   * without the server acting on what it carried.
   */
  app.addHook("onRequest", async (request, reply) => {
    const verdict = verifyCsrf(request, options.allowedOrigins);
    if (verdict.ok) return;

    logger.warn("cross-site request refused", {
      requestId: request.requestId,
      path: request.url,
      method: request.method,
      reason: verdict.reason,
      origin: request.headers.origin ?? null,
    });
    return reply.status(403).send({ error: "That request could not be verified." });
  });

  app.addHook("onResponse", async (request, reply) => {
    logger.info("request", {
      requestId: request.requestId,
      method: request.method,
      path: request.url,
      status: reply.statusCode,
      durationMillis: Math.round(reply.elapsedTime),
      hospitalId: options.resolveHospital(request),
      userId: request.authenticated?.user.account.id,
      branchId: request.authenticated?.session.branchId ?? null,
    });
  });

  app.setErrorHandler((error: Error, request, reply) => {
    logger.error("unhandled error", {
      requestId: request.requestId,
      path: request.url,
      error: error.message,
    });
    // The identifier is returned so a user can quote it and it can be found.
    // The message is not: it may describe the schema or the filesystem.
    void reply.status(500).send({
      error: "Something went wrong handling that request.",
      requestId: request.requestId,
    });
  });

  app.post(`${V1}/auth/login`, async (request, reply) => {
    /**
     * Rate limiting sits in front of lockout and guards the opposite attack:
     * one password tried against many usernames, where no single account ever
     * reaches its own limit.
     */
    const limit = rateLimiter.check(request.ip, now());
    if (!limit.allowed) {
      logger.warn("sign-in rate limited", {
        requestId: request.requestId,
        address: request.ip,
      });
      return reply
        .status(429)
        .header("Retry-After", Math.ceil((limit.retryAfter.getTime() - now().getTime()) / 1000))
        .send({ error: "Too many sign-in attempts. Wait a moment and try again." });
    }

    const body = (request.body ?? {}) as Credentials;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const branchId = typeof body.branchId === "string" ? body.branchId : null;

    if (username === "" || password === "") {
      return reply.status(400).send({ error: "Enter a username and password." });
    }

    const hospitalId = options.resolveHospital(request);
    const result = await options.auth.signIn({
      hospitalId,
      username,
      password,
      userAgent:
        typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : "",
      branchId: branchId as never,
    });

    if (!result.ok) {
      // Logged with the username, because a burst of these against one account
      // is what an attack looks like. Never with the password.
      logger.warn("sign-in refused", {
        requestId: request.requestId,
        hospitalId,
        username,
        reason: result.failure.reason,
      });
      const status = result.failure.reason === "account_locked" ? 429 : 401;
      return reply.status(status).send({
        error: result.failure.message,
        reason: result.failure.reason,
        ...(result.failure.retryAfter
          ? { retryAfter: result.failure.retryAfter.toISOString() }
          : {}),
      });
    }

    logger.info("signed in", {
      requestId: request.requestId,
      hospitalId,
      userId: result.user.account.id,
      branchId: result.session.branchId,
      device: result.session.device,
    });

    // A fresh CSRF token per session. Reusing one across sessions would let a
    // token captured from a shared workstation stay valid for the next person.
    const csrf = issueCsrfToken();
    startSession(reply, result.token, csrf, options.secureCookies);
    return reply.status(200).send({ user: describeUser(result.user, now()), csrfToken: csrf });
  });

  app.post(`${V1}/auth/logout`, async (request, reply) => {
    const token = readSessionToken(request);
    if (token !== null) await options.auth.signOut(token);
    endSessionCookies(reply, options.secureCookies);
    // 204 whether or not a session was found. Reporting the difference would
    // tell an unauthenticated caller whether a token it holds is still live.
    return reply.status(204).send();
  });

  app.get(
    `${V1}/auth/me`,
    { preHandler: requireSignedIn(guards) },
    async (request, reply) => {
      return reply.status(200).send({ user: describeUser(request.authenticated!.user, now()) });
    },
  );

  /**
   * Present so authorization is exercised by the suite from the moment it
   * exists, rather than first being tried when the queue endpoints land.
   */
  app.get(
    `${V1}/sessions`,
    { preHandler: requirePermission(guards, "admin.users") },
    async (_request, reply) => {
      return reply.status(200).send({ sessions: [] });
    },
  );

  /**
   * The event stream.
   *
   * A subscriber receives only its own branch's events: a display board in the
   * laboratory showing consultation tickets is not a cosmetic error, because
   * the waiting room acts on it.
   *
   * The heartbeat is what makes silence informative. The connection model the
   * surfaces use distinguishes "connected and quiet" from "connected in name
   * only", and without traffic on an idle stream an hour with no patients and a
   * severed cable are indistinguishable.
   */
  app.get(
    `${V1}/stream`,
    { preHandler: requireSignedIn(guards) },
    async (request, reply) => {
      const branchId = request.authenticated!.session.branchId;

      void reply
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-store")
        // Nginx buffers proxied responses by default, which holds every event
        // until the buffer fills — turning a live stream into a batch one.
        .header("X-Accel-Buffering", "no")
        .header("Connection", "keep-alive");

      reply.raw.writeHead(200, reply.getHeaders() as Record<string, string>);
      reply.raw.write(formatHeartbeat(now()));

      const unsubscribe = stream.subscribe({
        branchId,
        audience: "staff",
        send: (chunk) => reply.raw.write(chunk),
      });

      const beat = setInterval(() => {
        reply.raw.write(formatHeartbeat(now()));
      }, HEARTBEAT_MILLIS);

      // Both ends matter: the client closing, and the socket dying without one.
      const stop = (): void => {
        clearInterval(beat);
        unsubscribe();
      };
      request.raw.on("close", stop);
      request.raw.on("error", stop);

      return reply;
    },
  );

  if (options.configuration) {
    registerConfigRoutes(app, {
      ...options.configuration,
      guards,
      logger,
      resolveHospital: options.resolveHospital,
    });
  }

  if (options.configurationWrites) {
    registerConfigWriteRoutes(app, {
      ...options.configurationWrites,
      guards,
      logger,
      resolveHospital: options.resolveHospital,
    });
  }

  if (options.publicSurfaces) {
    registerPublicRoutes(app, { ...options.publicSurfaces, logger, now });
  }

  if (options.queue) {
    registerQueueRoutes(app, {
      ...options.queue,
      guards,
      logger,
      stream,
      resolveHospital: options.resolveHospital,
    });
  }

  app.get("/api/health", async (_request, reply) => {
    return reply.status(200).send({ status: "ok", at: now().toISOString() });
  });

  return app;
}

/**
 * What a signed-in client is told about itself.
 *
 * Assembled explicitly rather than by serialising the account, so a column
 * added to `users` later — a personal phone number, a national identifier —
 * does not silently start appearing in a response body.
 */
function describeUser(user: AuthenticatedUser, at: Date): Record<string, unknown> {
  return {
    id: user.account.id,
    displayName: user.account.displayName,
    username: user.account.username,
    roleId: user.account.roleId,
    branchId: user.branchId,
    branchIds: user.account.branchIds,
    permissions: user.permissions,
    at: at.toISOString(),
  };
}
