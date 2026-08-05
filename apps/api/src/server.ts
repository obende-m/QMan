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
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser, Session } from "@qman/domain";
import type { AuthService } from "./auth.js";
import { silentLogger, type Logger } from "./logging.js";

export const SESSION_COOKIE = "qman_session";

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
  readonly now?: () => Date;
}

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
    authenticated?: { user: AuthenticatedUser; session: Session };
  }
}

interface Credentials {
  username?: unknown;
  password?: unknown;
  branchId?: unknown;
}

function readToken(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;

  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    // Unreadable from JavaScript, so a script injected into any of the three
    // surfaces cannot read the session out of document.cookie.
    "HttpOnly",
    // Lax rather than Strict: the display board and patient tracker are opened
    // from links and QR codes, and Strict would drop the cookie on arrival.
    // Lax still withholds it from cross-site POSTs, which is the attack.
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  reply.header("Set-Cookie", attributes.join("; "));
}

function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  const attributes = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) attributes.push("Secure");
  reply.header("Set-Cookie", attributes.join("; "));
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const logger = options.logger ?? silentLogger();
  const now = options.now ?? (() => new Date());
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

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

  app.post("/api/auth/login", async (request, reply) => {
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
      userAgent: typeof request.headers["user-agent"] === "string"
        ? request.headers["user-agent"]
        : "",
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

    setSessionCookie(reply, result.token, options.secureCookies);
    return reply.status(200).send({ user: describeUser(result.user, now()) });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = readToken(request);
    if (token !== null) await options.auth.signOut(token);
    clearSessionCookie(reply, options.secureCookies);
    // 204 whether or not a session was found. Reporting the difference would
    // tell an unauthenticated caller whether a token it holds is still live.
    return reply.status(204).send();
  });

  app.get("/api/auth/me", async (request, reply) => {
    const token = readToken(request);
    if (token === null) {
      return reply.status(401).send({ error: "Not signed in." });
    }

    const resolved = await options.auth.resolve(token);
    if (resolved === null) {
      clearSessionCookie(reply, options.secureCookies);
      return reply.status(401).send({ error: "Your session has ended. Sign in again." });
    }

    request.authenticated = resolved;
    return reply.status(200).send({ user: describeUser(resolved.user, now()) });
  });

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
