/**
 * Platform authorization.
 *
 * Deliberately a separate file, a separate cookie, a separate service and a
 * separate permission type from `authorization.ts`. The two guards share their
 * posture — deny by default, the permission declared on the route rather than
 * checked inside the handler, 401 and 403 meaning different things — and share
 * no way to satisfy one with the other's credential.
 *
 * The property to preserve when editing this file: there is no expression here
 * that reads an organization session, and none in `authorization.ts` that reads
 * a platform one. A platform administrator cannot become a hospital's
 * administrator by holding a platform session, because nothing maps one to the
 * other. Impersonation, when it is built, will be an explicit and audited act
 * of minting an organization session — not a consequence of this guard being
 * lenient.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PlatformPermission } from "@qman/domain";
import type { Logger } from "./logging.js";
import type { PlatformAuthService } from "./platform-auth.js";

/**
 * A different cookie name from the organization session, and that is the
 * mechanism rather than a convention.
 *
 * A platform token presented as `qman_session` is looked up in `sessions`,
 * where it does not exist. An organization token presented here is looked up in
 * `platform_sessions`, where it does not exist. Neither rejection depends on a
 * check anybody has to remember to write.
 */
export const PLATFORM_SESSION_COOKIE = "qman_platform_session";

export function readPlatformSessionToken(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === PLATFORM_SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export interface PlatformGuardDependencies {
  readonly auth: PlatformAuthService;
  readonly logger: Logger;
}

export async function authenticatePlatform(
  deps: PlatformGuardDependencies,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const token = readPlatformSessionToken(request);
  if (token === null) {
    void reply.status(401).send({ error: "Not signed in." });
    return false;
  }

  const resolved = await deps.auth.resolve(token);
  if (resolved === null) {
    void reply.status(401).send({ error: "Your session has ended. Sign in again." });
    return false;
  }

  request.platform = resolved;
  return true;
}

/**
 * A preHandler enforcing one platform permission.
 *
 * The permission set comes from the account's platform role, which is a closed
 * set in the domain. A hospital's roles cannot contribute to it: they are a
 * different table, a different type, and `validateRoles` refuses to store a
 * `platform.` grant even if one is sent by hand. That refusal is the reason an
 * organization administrator cannot reach any of these routes — not this guard
 * being careful, but there being no credential they can construct that this
 * guard would accept.
 */
export function requirePlatformPermission(
  deps: PlatformGuardDependencies,
  permission: PlatformPermission,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!(await authenticatePlatform(deps, request, reply))) return;

    const platform = request.platform!;
    if (!platform.user.permissions.includes(permission)) {
      deps.logger.warn("platform permission refused", {
        requestId: request.requestId,
        path: request.url,
        platformUserId: platform.user.id,
        permission,
      });
      void reply.status(403).send({
        error: "You do not have permission to do that.",
        permission,
      });
      return;
    }
  };
}

/** A preHandler requiring only that a platform administrator is signed in. */
export function requirePlatformSignedIn(deps: PlatformGuardDependencies) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await authenticatePlatform(deps, request, reply);
  };
}
