/**
 * Platform administration routes.
 *
 * Everything QMan does to the organizations it hosts. Every route beneath
 * `/api/v1/platform` requires a platform session; none of them accepts an
 * organization one, and none of them returns a hospital's clinical or staff
 * data. The list says how many branches and users an organization has, never
 * who they are.
 *
 * `/platform` is a trust boundary rather than a grouping. Adding a route here
 * without `requirePlatformPermission` would be adding it to the wrong tree.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLES,
  normaliseOrganizationCode,
  validateOrganizationCode,
  validateOrganizationName,
  type Organization,
} from "@qman/domain";
import type {
  OrganizationDirectoryRepository,
  PlatformEventRepository,
  PlatformUserRepository,
} from "@qman/persistence";
import { CSRF_COOKIE, issueCsrfToken } from "./csrf.js";
import type { Logger } from "./logging.js";
import type { PlatformAuthService } from "./platform-auth.js";
import {
  PLATFORM_SESSION_COOKIE,
  readPlatformSessionToken,
  requirePlatformPermission,
  requirePlatformSignedIn,
  type PlatformGuardDependencies,
} from "./platform-authorization.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import { V1 } from "./version.js";

/**
 * Creating an organization.
 *
 * A port rather than SQL inline in a handler, so the transaction that makes a
 * hospital exist is testable without a route and replaceable without touching
 * one. The implementation reuses the domain's `DEFAULT_ROLES` and the same
 * scrypt hashing every other password in the system uses — there is no second
 * definition of what a new hospital starts with.
 */
export interface OrganizationProvisioning {
  create(input: {
    readonly code: string;
    readonly name: string;
    readonly timezone: string;
    readonly branchName: string;
    readonly adminUsername: string;
    readonly adminDisplayName: string;
    readonly at: Date;
  }): Promise<{ readonly organizationId: string; readonly adminPassword: string }>;

  /**
   * Resets one organization's administrator password.
   *
   * Returns null when the organization has no administrator to reset, which is
   * a real state — a hospital whose only admin account was deleted is exactly
   * the case this exists for, and it needs a clear answer rather than a crash.
   */
  resetAdministrator(input: {
    readonly organizationId: string;
    readonly username: string;
    readonly at: Date;
  }): Promise<{ readonly username: string; readonly password: string } | null>;
}

export interface PlatformRouteDependencies {
  readonly auth: PlatformAuthService;
  readonly events: PlatformEventRepository;
  readonly users: PlatformUserRepository;
  readonly organizations: OrganizationDirectoryRepository;
  readonly provisioning: OrganizationProvisioning;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly secureCookies: boolean;
  readonly rateLimiter?: RateLimiter;
}

interface CookieOptions {
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly maxAge?: number;
}

function cookie(name: string, value: string, options: CookieOptions): string {
  const attributes = [`${name}=${encodeURIComponent(value)}`, "Path=/"];
  if (options.httpOnly) attributes.push("HttpOnly");
  if (options.secure) attributes.push("Secure");
  if (options.maxAge !== undefined) attributes.push(`Max-Age=${options.maxAge}`);
  attributes.push("SameSite=Lax");
  return attributes.join("; ");
}

function describeOrganization(organization: Organization) {
  return {
    // The immutable identity. Everything the portal does afterwards keys on it.
    id: organization.id,
    code: organization.code,
    name: organization.name,
    status: organization.status,
    timezone: organization.timezone,
    suspendedAt: organization.suspendedAt?.toISOString() ?? null,
    suspendedReason: organization.suspendedReason,
    createdAt: organization.createdAt.toISOString(),
  };
}

export function registerPlatformRoutes(
  app: FastifyInstance,
  deps: PlatformRouteDependencies,
): void {
  const guards: PlatformGuardDependencies = { auth: deps.auth, logger: deps.logger };
  const rateLimiter = deps.rateLimiter ?? createRateLimiter();
  const P = `${V1}/platform`;

  /** Writes one platform audit record. Never optional on a state change. */
  const audit = async (
    request: { requestId: string; platform?: { user: { id: string } } },
    type: string,
    targetHospitalId: string | null,
    summary: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> => {
    await deps.events.append({
      type,
      actorId: request.platform?.user.id ?? null,
      targetHospitalId,
      correlationId: request.requestId,
      occurredAt: deps.now(),
      payload,
      summary,
    });
  };

  // ────────────────────────────────────────────────────────── authentication

  app.post(`${P}/auth/login`, async (request, reply) => {
    const limit = rateLimiter.check(request.ip, deps.now());
    if (!limit.allowed) {
      deps.logger.warn("platform sign-in rate limited", {
        requestId: request.requestId,
        address: request.ip,
      });
      return reply
        .status(429)
        .header(
          "Retry-After",
          Math.ceil((limit.retryAfter.getTime() - deps.now().getTime()) / 1000),
        )
        .send({ error: "Too many sign-in attempts. Wait a moment and try again." });
    }

    const body = (request.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (username === "" || password === "") {
      return reply.status(400).send({ error: "Enter a username and password." });
    }

    const result = await deps.auth.signIn({
      username,
      password,
      userAgent:
        typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : "",
    });

    if (!result.ok) {
      // Logged with the username: a burst of these is what an attack on the
      // platform's own administrators looks like. Never with the password.
      deps.logger.warn("platform sign-in refused", {
        requestId: request.requestId,
        username,
        reason: result.failure.reason,
      });
      const status = result.failure.reason === "account_locked" ? 429 : 401;
      return reply.status(status).send({
        error: result.failure.message,
        reason: result.failure.reason,
      });
    }

    deps.logger.info("platform signed in", {
      requestId: request.requestId,
      platformUserId: result.user.id,
    });

    const csrf = issueCsrfToken();
    void reply.header("Set-Cookie", [
      cookie(PLATFORM_SESSION_COOKIE, result.token, {
        secure: deps.secureCookies,
        httpOnly: true,
      }),
      cookie(CSRF_COOKIE, csrf, { secure: deps.secureCookies, httpOnly: false }),
    ]);

    await audit(request, "platform.signed_in", null, `${result.user.username} signed in.`, {
      platformUserId: result.user.id,
    });

    return reply.status(200).send({ user: result.user, csrfToken: csrf });
  });

  app.post(`${P}/auth/logout`, async (request, reply) => {
    const token = readPlatformSessionToken(request);
    if (token !== null) await deps.auth.signOut(token);
    endPlatformCookies(reply, deps.secureCookies);
    // 204 whether or not a session was found: reporting the difference would
    // tell an unauthenticated caller whether a token it holds is still live.
    return reply.status(204).send();
  });

  app.get(
    `${P}/auth/me`,
    { preHandler: requirePlatformSignedIn(guards) },
    async (request, reply) => reply.status(200).send({ user: request.platform!.user }),
  );

  // ───────────────────────────────────────────────────────────── organizations

  app.get(
    `${P}/organizations`,
    { preHandler: requirePlatformPermission(guards, "platform.organizations.view") },
    async (_request, reply) => {
      const organizations = await deps.organizations.list();
      return reply.status(200).send({
        organizations: organizations.map((organization) => ({
          ...describeOrganization(organization),
          branchCount: organization.branchCount,
          userCount: organization.userCount,
        })),
      });
    },
  );

  app.get(
    `${P}/organizations/:id`,
    { preHandler: requirePlatformPermission(guards, "platform.organizations.view") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const organization = await deps.organizations.findById(id);
      if (organization === null) {
        return reply.status(404).send({ error: "No such organization." });
      }
      return reply.status(200).send({ organization: describeOrganization(organization) });
    },
  );

  app.post(
    `${P}/organizations`,
    { preHandler: requirePlatformPermission(guards, "platform.organizations.create") },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const code = normaliseOrganizationCode(
        typeof body["code"] === "string" ? body["code"] : "",
      );
      const name = typeof body["name"] === "string" ? body["name"].trim() : "";
      const timezone = typeof body["timezone"] === "string" ? body["timezone"] : "UTC";
      const branchName =
        typeof body["branchName"] === "string" && body["branchName"].trim() !== ""
          ? body["branchName"].trim()
          : "Main Branch";
      const adminUsername =
        typeof body["adminUsername"] === "string" ? body["adminUsername"].trim() : "";
      const adminDisplayName =
        typeof body["adminDisplayName"] === "string" && body["adminDisplayName"].trim() !== ""
          ? body["adminDisplayName"].trim()
          : "Administrator";

      const problems = [
        ...validateOrganizationCode(code),
        ...validateOrganizationName(name),
        ...(adminUsername === "" ? ["An administrator username is required."] : []),
      ];
      if (problems.length > 0) {
        return reply.status(422).send({ error: "That organization is not valid.", problems });
      }

      if (await deps.organizations.isCodeTaken(code)) {
        return reply.status(409).send({
          error: `The code “${code}” is already in use by another organization.`,
        });
      }

      const created = await deps.provisioning.create({
        code,
        name,
        timezone,
        branchName,
        adminUsername,
        adminDisplayName,
        at: deps.now(),
      });

      await audit(
        request,
        "platform.organization_created",
        created.organizationId,
        `Created ${name} (${code}).`,
        // The name is copied into the payload deliberately: the audit record
        // must still read after the organization row is gone, and the foreign
        // key is ON DELETE SET NULL for exactly that reason.
        { name, code, adminUsername },
      );

      deps.logger.info("organization created", {
        requestId: request.requestId,
        hospitalId: created.organizationId,
        platformUserId: request.platform!.user.id,
      });

      const organization = await deps.organizations.findById(created.organizationId);
      return reply.status(201).send({
        organization: organization === null ? null : describeOrganization(organization),
        // Returned exactly once, and never stored in plaintext anywhere.
        administrator: { username: adminUsername, password: created.adminPassword },
      });
    },
  );

  app.post(
    `${P}/organizations/:id/suspend`,
    { preHandler: requirePlatformPermission(guards, "platform.organizations.suspend") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { reason?: unknown };
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";

      const organization = await deps.organizations.findById(id);
      if (organization === null) {
        return reply.status(404).send({ error: "No such organization." });
      }
      if (reason === "") {
        return reply
          .status(422)
          .send({ error: "A reason is required.", problems: ["Give a reason for suspending."] });
      }

      await deps.organizations.setStatus(id, "suspended", reason, deps.now());
      await audit(
        request,
        "platform.organization_suspended",
        id,
        `Suspended ${organization.name}: ${reason}`,
        { name: organization.name, code: organization.code, reason },
      );

      deps.logger.warn("organization suspended", {
        requestId: request.requestId,
        hospitalId: id,
        platformUserId: request.platform!.user.id,
      });

      const updated = await deps.organizations.findById(id);
      return reply
        .status(200)
        .send({ organization: updated === null ? null : describeOrganization(updated) });
    },
  );

  app.post(
    `${P}/organizations/:id/reactivate`,
    { preHandler: requirePlatformPermission(guards, "platform.organizations.suspend") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const organization = await deps.organizations.findById(id);
      if (organization === null) {
        return reply.status(404).send({ error: "No such organization." });
      }

      await deps.organizations.setStatus(id, "active", null, deps.now());
      await audit(
        request,
        "platform.organization_reactivated",
        id,
        `Reactivated ${organization.name}.`,
        { name: organization.name, code: organization.code },
      );

      const updated = await deps.organizations.findById(id);
      return reply
        .status(200)
        .send({ organization: updated === null ? null : describeOrganization(updated) });
    },
  );

  app.post(
    `${P}/organizations/:id/admin-reset`,
    { preHandler: requirePlatformPermission(guards, "platform.organizations.reset_admin") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { username?: unknown };
      const username = typeof body.username === "string" ? body.username.trim() : "";

      const organization = await deps.organizations.findById(id);
      if (organization === null) {
        return reply.status(404).send({ error: "No such organization." });
      }
      if (username === "") {
        return reply.status(422).send({
          error: "A username is required.",
          problems: ["Name the administrator account to reset."],
        });
      }

      const reset = await deps.provisioning.resetAdministrator({
        organizationId: id,
        username,
        at: deps.now(),
      });

      if (reset === null) {
        return reply
          .status(404)
          .send({ error: "That organization has no such administrator account." });
      }

      await audit(
        request,
        "platform.organization_admin_reset",
        id,
        `Reset the password for ${username} at ${organization.name}.`,
        { name: organization.name, username },
      );

      deps.logger.warn("organization administrator reset", {
        requestId: request.requestId,
        hospitalId: id,
        platformUserId: request.platform!.user.id,
      });

      // Returned once. The old password is never revealed, and no organization
      // data beyond the administrator's username is returned with it.
      return reply.status(200).send({ administrator: reset });
    },
  );

  // ──────────────────────────────────────────────────────────────── audit

  app.get(
    `${P}/audit`,
    { preHandler: requirePlatformPermission(guards, "platform.audit.view") },
    async (request, reply) => {
      const query = request.query as { organizationId?: string; limit?: string };
      const events = await deps.events.query({
        ...(query.organizationId ? { targetHospitalId: query.organizationId } : {}),
        ...(query.limit ? { limit: Number(query.limit) } : {}),
      });
      return reply.status(200).send({
        events: events.map((event) => ({
          id: event.id,
          sequence: event.sequence,
          type: event.type,
          actorId: event.actorId,
          organizationId: event.targetHospitalId,
          correlationId: event.correlationId,
          at: event.occurredAt.toISOString(),
          summary: event.summary,
          payload: event.payload,
        })),
      });
    },
  );

  // ──────────────────────────────────────────────────────────────── health

  app.get(
    `${P}/health`,
    { preHandler: requirePlatformPermission(guards, "platform.health.view") },
    async (_request, reply) => {
      const organizations = await deps.organizations.list();
      const administrators = await deps.users.count();

      return reply.status(200).send({
        organizations: {
          total: organizations.length,
          active: organizations.filter((o) => o.status === "active").length,
          suspended: organizations.filter((o) => o.status === "suspended").length,
        },
        branches: organizations.reduce((sum, o) => sum + o.branchCount, 0),
        users: organizations.reduce((sum, o) => sum + o.userCount, 0),
        platformAdministrators: administrators,
        at: deps.now().toISOString(),
      });
    },
  );
}

function endPlatformCookies(reply: FastifyReply, secure: boolean): void {
  void reply.header("Set-Cookie", [
    cookie(PLATFORM_SESSION_COOKIE, "", { secure, httpOnly: true, maxAge: 0 }),
    cookie(CSRF_COOKIE, "", { secure, httpOnly: false, maxAge: 0 }),
  ]);
}

/** The permission set a new organization's administrator role starts with. */
export const ORGANIZATION_ADMIN_PERMISSIONS = ALL_PERMISSIONS;

/** The roles a new organization starts with. The domain's, not a copy. */
export const NEW_ORGANIZATION_ROLES = DEFAULT_ROLES;
