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
import { GENERIC_AUTH_FAILURE, type AuthService } from "./auth.js";
import type {
  OrganizationDirectoryRepository,
  PlatformEventRepository,
  PlatformUserRepository,
} from "@qman/persistence";
import type { PlatformAuthService, ResolvedPlatformSession } from "./platform-auth.js";
import {
  registerPlatformRoutes,
  type OrganizationProvisioning,
} from "./platform-routes.js";
import {
  readSessionToken,
  requirePermission,
  requireSignedIn,
  SESSION_COOKIE,
  type GuardDependencies,
  tenantOf,
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
import {

  registerAdministrationRoutes,
  type AdministrationRouteDependencies,
} from "./admin-routes.js";
import { categoryOf } from "@qman/domain";
import type { EventRepository, NewEvent } from "@qman/persistence";
import { V1 } from "./version.js";

export { SESSION_COOKIE };
export { CSRF_COOKIE, CSRF_HEADER } from "./csrf.js";

export interface ServerOptions {
  readonly auth: AuthService;
  readonly logger?: Logger;
  /**
   * Which hospital a request belongs to.
   */
  readonly organizations: OrganizationDirectoryRepository;
  /** Platform administration. Registered only when its service exists. */
  readonly platform?: {
    readonly auth: PlatformAuthService;
    readonly events: PlatformEventRepository;
    readonly users: PlatformUserRepository;
    readonly provisioning: OrganizationProvisioning;
  };
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
  readonly configuration?: Omit<ConfigRouteDependencies, "guards" | "logger">;
  /** Configuration writes. Registered only when the service exists. */
  readonly configurationWrites?: Omit<ConfigWriteDependencies, "guards" | "logger">;
  /** The two unauthenticated surfaces. Registered only when configured. */
  readonly publicSurfaces?: Omit<PublicRouteDependencies, "logger" | "now">;
  /** Business routes are registered only when their repositories exist. */
  readonly queue?: Omit<QueueRouteDependencies, "guards" | "logger" | "stream">;
  /**
   * Which proxies' `X-Forwarded-For` to believe. See `parseTrustProxy`.
   * Defaults to none, so `request.ip` is the socket's address.
   */
  readonly trustProxy?: false | number | readonly string[];
  /**
   * Checks the database answers, for the health endpoint. Absent in suites
   * with no database; every deployment supplies one.
   */
  readonly checkDatabase?: () => Promise<void>;
  /** User and session administration. Registered only when its service exists. */
  readonly administration?: Omit<AdministrationRouteDependencies, "guards" | "logger" | "now">;
  /**
   * Where sign-in, sign-out and failed sign-in records are written. Every
   * deployment supplies it; the security log is not optional.
   */
  readonly securityEvents?: EventRepository;
}

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
    authenticated?: {
      user: AuthenticatedUser;
      session: Session;
      hospitalId: string;
      passwordChangeRequired?: boolean;
    };
    /**
     * Set only by the platform guard, and never by the organization one. The
     * two live side by side on the request and neither reads the other.
     */
    platform?: ResolvedPlatformSession;
    /**
     * The tenant this request turned out to concern, for logging only.
     *
     * Authenticated requests take it from the session. Sign-in has no session
     * yet but does resolve an organization, and a sign-in whose log entry
     * cannot say which hospital it was for is the one entry an incident most
     * needs. Never read for an authorization decision — `tenantOf` is the only
     * source for that, and it reads the session.
     */
    tenantId?: string;
  }
}

interface Credentials {
  organization?: unknown;
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

/**
 * PostgreSQL SQLSTATE codes that mean "you asked for something the rules do not
 * allow", and the answer each deserves.
 *
 * Deliberately narrow. Codes not listed here — a syntax error, an undefined
 * column, a failed connection — are genuine faults and must keep returning 500,
 * because they are the server's problem and not the caller's.
 */
const CONSTRAINT_RESPONSES: Record<string, { status: number; message: string }> = {
  // unique_violation: a code, name or key that is already taken.
  "23505": {
    status: 409,
    message: "Something with that identifier already exists. Choose another.",
  },
  // foreign_key_violation: referencing something absent, or deleting something
  // still referenced.
  "23503": {
    status: 409,
    message: "That is still in use, or refers to something that no longer exists.",
  },
  // check_violation: a value outside the set the schema allows.
  "23514": { status: 422, message: "That value is not allowed here." },
  // not_null_violation: a required field arrived empty.
  "23502": { status: 422, message: "A required value is missing." },
  // invalid_text_representation: a malformed uuid in a path, most often.
  "22P02": { status: 400, message: "That identifier is not valid." },
};

export function buildServer(options: ServerOptions): FastifyInstance {
  const logger = options.logger ?? silentLogger();
  const now = options.now ?? (() => new Date());
  const rateLimiter = options.rateLimiter ?? createRateLimiter();
  const stream = options.stream ?? new EventStream();
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    trustProxy:
      options.trustProxy === undefined || options.trustProxy === false
        ? false
        : typeof options.trustProxy === "number"
          ? options.trustProxy
          : [...options.trustProxy],
  });

  const guards: GuardDependencies = { auth: options.auth, logger };

  /**
   * Writes one security record, and never fails the request for it.
   *
   * A sign-in that succeeded must not be reported as a failure because the
   * audit write did not land; the failure is logged loudly instead, where
   * monitoring will see it.
   */
  const recordSecurity = async (event: NewEvent): Promise<void> => {
    if (options.securityEvents === undefined) return;
    try {
      await options.securityEvents.append([event]);
    } catch (error) {
      logger.error("security record not written", {
        type: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      hospitalId: request.authenticated?.hospitalId ?? request.tenantId,
      userId: request.authenticated?.user.account.id,
      platformUserId: request.platform?.user.id,
      branchId: request.authenticated?.session.branchId ?? null,
    });
  });

  app.setErrorHandler((error: Error, request, reply) => {
    /*
     * A constraint the database enforces is a business rule, not a crash.
     *
     * Every one of these is something a user can do on purpose: reusing a
     * station code, deleting a workflow a visit still references, storing a
     * status the CHECK does not allow. Answering 500 tells them "something went
     * wrong" for a decision they made and could correct, and puts an alarm in
     * the log for a working system.
     *
     * Mapped here rather than at each call site, so a constraint added later is
     * covered by default. The detail is deliberately not returned: it names
     * columns and constraints, which is schema disclosure. The request id is,
     * so a support call can find this entry.
     */
    const code = (error as { code?: unknown }).code;
    const constraint = typeof code === "string" ? CONSTRAINT_RESPONSES[code] : undefined;
    if (constraint !== undefined) {
      logger.warn("constraint refused", {
        requestId: request.requestId,
        path: request.url,
        hospitalId: request.authenticated?.hospitalId,
        pgCode: code,
        constraint: (error as { constraint?: string }).constraint,
      });
      return reply.status(constraint.status).send({
        error: constraint.message,
        requestId: request.requestId,
      });
    }

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
    const organizationCode =
      typeof body.organization === "string" ? body.organization.trim() : "";

    if (username === "" || password === "" || organizationCode === "") {
      return reply
        .status(400)
        .send({ error: "Enter an organization code, username and password." });
    }

    /*
     * The one place an organization code becomes an organization id.
     *
     * After this line the code is not consulted again: the id scopes the
     * session, every subsequent query and every audit record. That is what
     * makes the code editable — it is a selector, not identity.
     */
    const organization = await options.organizations.findByCode(organizationCode);

    /*
     * An unknown organization is answered exactly as a wrong password is.
     *
     * Distinguishing them would turn this form into an oracle for which
     * hospitals QMan hosts, which is commercially sensitive and is a list an
     * attacker would otherwise have to guess. The delay is not equalised here
     * because the expensive part — scrypt — runs in both cases below only when
     * an organization was found; a lookup miss is answered from one indexed
     * query and is not usefully distinguishable from a lookup hit.
     */
    if (organization === null) {
      logger.warn("sign-in refused", {
        requestId: request.requestId,
        organizationCode,
        reason: "unknown_organization",
      });
      return reply.status(401).send({
        error: GENERIC_AUTH_FAILURE,
        reason: "invalid_credentials",
      });
    }

    /*
     * Suspension is enforced before credentials are checked, and says so.
     *
     * This is the one place a specific message is right rather than uniform.
     * The staff of a suspended hospital are not attackers probing for accounts;
     * they are people whose employer's account is in arrears or under review,
     * and "your organization is suspended, contact QMan" is information they
     * can act on. A generic failure would send them to reset passwords that
     * were never wrong.
     */
    if (organization.status !== "active") {
      logger.warn("sign-in refused", {
        requestId: request.requestId,
        hospitalId: organization.id,
        reason: "organization_suspended",
      });
      return reply.status(403).send({
        error: "This organization is suspended. Contact QMan support.",
        reason: "organization_suspended",
      });
    }

    const hospitalId = organization.id;
    request.tenantId = hospitalId;
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
      await recordSecurity({
        hospitalId: hospitalId as NewEvent["hospitalId"],
        branchId: null as unknown as NewEvent["branchId"],
        category: categoryOf("auth.sign_in_failed"),
        type: result.failure.reason === "account_locked" ? "auth.account_locked" : "auth.sign_in_failed",
        visitId: null,
        correlationId: null,
        actorId: null,
        occurredAt: now(),
        // The username tried, which is what an investigation of a guessing
        // attack follows. Never the password.
        payload: { username: username.slice(0, 64), reason: result.failure.reason },
        summary:
          result.failure.reason === "account_locked"
            ? `Sign-in refused for ${username.slice(0, 64)}: account locked`
            : `Failed sign-in for ${username.slice(0, 64)}`,
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

    const signedInAt = now();
    await recordSecurity({
      hospitalId: hospitalId as NewEvent["hospitalId"],
      branchId: null as unknown as NewEvent["branchId"],
      category: categoryOf("auth.signed_in"),
      type: "auth.signed_in",
      visitId: null,
      correlationId: result.session.id,
      actorId: result.user.account.id,
      occurredAt: signedInAt,
      payload: { device: result.session.device, branchId: result.session.branchId },
      summary: `${result.user.account.username} signed in on ${result.session.device || "an unknown device"}`,
    });
    await options.administration?.administration.recordSignIn(result.user.account.id, signedInAt);

    return reply.status(200).send({
      user: describeUser(result.user, now(), result.passwordChangeRequired),
      csrfToken: csrf,
    });
  });

  app.post(`${V1}/auth/logout`, async (request, reply) => {
    const token = readSessionToken(request);
    if (token !== null) {
      // Resolved first so the record can say who signed out. A token that no
      // longer resolves has nothing to record.
      const resolved = await options.auth.resolve(token);
      await options.auth.signOut(token);
      if (resolved !== null) {
        await recordSecurity({
          hospitalId: resolved.hospitalId as NewEvent["hospitalId"],
          branchId: null as unknown as NewEvent["branchId"],
          category: categoryOf("auth.signed_out"),
          type: "auth.signed_out",
          visitId: null,
          correlationId: resolved.session.id,
          actorId: resolved.user.account.id,
          occurredAt: now(),
          payload: {},
          summary: `${resolved.user.account.username} signed out`,
        });
      }
    }
    endSessionCookies(reply, options.secureCookies);
    // 204 whether or not a session was found. Reporting the difference would
    // tell an unauthenticated caller whether a token it holds is still live.
    return reply.status(204).send();
  });

  app.get(
    `${V1}/auth/me`,
    { preHandler: requireSignedIn(guards) },
    async (request, reply) => {
      const authenticated = request.authenticated!;
      return reply.status(200).send({
        user: describeUser(authenticated.user, now(), authenticated.passwordChangeRequired === true),
      });
    },
  );

  if (options.administration) {
    registerAdministrationRoutes(app, { ...options.administration, guards, logger, now });
  } else {
    /**
     * Without administration configured, the session list still exists and is
     * still guarded, so authorization is exercised by suites that build a
     * server without it.
     */
    app.get(
      `${V1}/sessions`,
      { preHandler: requirePermission(guards, "admin.users") },
      async (_request, reply) => {
        return reply.status(200).send({ sessions: [] });
      },
    );
  }

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
        hospitalId: tenantOf(request),
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
    });
  }

  if (options.configurationWrites) {
    registerConfigWriteRoutes(app, {
      ...options.configurationWrites,
      guards,
      logger,
    });
  }

  if (options.publicSurfaces) {
    registerPublicRoutes(app, {
      ...options.publicSurfaces,
      organizations: options.organizations,
      logger,
      now,
    });
  }

  if (options.platform) {
    registerPlatformRoutes(app, {
      auth: options.platform.auth,
      events: options.platform.events,
      users: options.platform.users,
      provisioning: options.platform.provisioning,
      organizations: options.organizations,
      logger,
      now,
      secureCookies: options.secureCookies,
    });
  }

  if (options.queue) {
    registerQueueRoutes(app, {
      ...options.queue,
      guards,
      logger,
      stream,
    });
  }

  /**
   * Liveness: the process is up and serving HTTP. Nothing else.
   *
   * For a supervisor deciding whether to restart the process, which a database
   * outage should not cause — a restart cannot fix the database.
   */
  app.get("/api/live", async (_request, reply) => {
    return reply.status(200).send({ status: "ok", at: now().toISOString() });
  });

  /**
   * Health: whether this instance can do its job, which means reaching the
   * database. Used by load balancers to stop routing to an instance that would
   * answer every request with a 500.
   *
   * Bounded by a timeout, so a database that hangs rather than refusing is
   * reported as down instead of holding the probe open. The error is logged
   * and not returned: it names hosts and ports.
   */
  app.get("/api/health", async (request, reply) => {
    if (options.checkDatabase === undefined) {
      return reply.status(200).send({ status: "ok", database: "not_configured", at: now().toISOString() });
    }
    try {
      await Promise.race([
        options.checkDatabase(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 3_000)),
      ]);
      return reply.status(200).send({ status: "ok", database: "ok", at: now().toISOString() });
    } catch (error) {
      logger.error("health check failed", {
        requestId: request.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return reply
        .status(503)
        .header("Cache-Control", "no-store")
        .send({ status: "unavailable", database: "unreachable", at: now().toISOString() });
    }
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
function describeUser(
  user: AuthenticatedUser,
  at: Date,
  passwordChangeRequired = false,
): Record<string, unknown> {
  return {
    passwordChangeRequired,
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
