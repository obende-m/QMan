/**
 * Authorization.
 *
 * Until now, permissions decided which buttons a screen drew. That is a
 * usability feature and was never a security control: a hidden button is a
 * request anyone can still make with a terminal. This is where the decision
 * actually happens, on the server, for every request, against the permission
 * the route declares it needs.
 *
 * Three properties are deliberate.
 *
 * **Routes declare what they need, in one place.** The permission sits on the
 * route definition, not inside the handler, so an endpoint cannot be added that
 * forgot to check — the guard is part of registering it.
 *
 * **Deny is the default.** `requirePermission` is required to reach a handler;
 * there is no path that reaches one without passing through here.
 *
 * **401 and 403 mean different things.** 401 says "I do not know who you are",
 * and the client should offer a sign-in. 403 says "I know exactly who you are
 * and you may not do this", and offering a sign-in would be nonsense — the user
 * is already signed in, and re-entering their password changes nothing.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Permission } from "@qman/domain";
import type { AuthService } from "./auth.js";
import type { Logger } from "./logging.js";

export const SESSION_COOKIE = "qman_session";

export function readSessionToken(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export interface GuardDependencies {
  readonly auth: AuthService;
  readonly logger: Logger;
  readonly resolveHospital: (request: FastifyRequest) => string;
}

/**
 * Resolves the caller, or refuses the request.
 *
 * Returns a boolean rather than throwing so the caller stops cleanly; Fastify
 * treats a reply already sent as the end of the request.
 */
export async function authenticate(
  deps: GuardDependencies,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const token = readSessionToken(request);
  if (token === null) {
    void reply.status(401).send({ error: "Not signed in." });
    return false;
  }

  const resolved = await deps.auth.resolve(token);
  if (resolved === null) {
    void reply.status(401).send({ error: "Your session has ended. Sign in again." });
    return false;
  }

  request.authenticated = resolved;
  return true;
}

/**
 * A preHandler enforcing one permission.
 *
 * The tenant check is not a formality. A session is bound to a user, and a user
 * to a hospital; a request whose resolved hospital differs from the account's
 * is either a misconfiguration or an attempt to reach another hospital's data
 * with a valid session. Both are refused, and the second is worth an alarm in
 * the log rather than a quiet 403.
 */
export function requirePermission(deps: GuardDependencies, permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!(await authenticate(deps, request, reply))) return;

    const authenticated = request.authenticated!;
    const hospitalId = deps.resolveHospital(request);

    if (authenticated.hospitalId !== hospitalId) {
      deps.logger.error("cross-tenant request refused", {
        requestId: request.requestId,
        path: request.url,
        userId: authenticated.user.account.id,
        hospitalId,
        accountHospitalId: authenticated.hospitalId,
      });
      void reply.status(403).send({ error: "You do not have access to this hospital." });
      return;
    }

    if (!authenticated.user.permissions.includes(permission)) {
      deps.logger.warn("permission refused", {
        requestId: request.requestId,
        path: request.url,
        hospitalId,
        userId: authenticated.user.account.id,
        permission,
      });
      // The permission is named. The caller is a member of staff, not an
      // attacker probing for endpoints, and "you need queue.call" is what lets
      // them ask an administrator for the right thing.
      void reply.status(403).send({
        error: "You do not have permission to do that.",
        permission,
      });
      return;
    }
  };
}

/** A preHandler requiring only that the caller is signed in. */
export function requireSignedIn(deps: GuardDependencies) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await authenticate(deps, request, reply);
  };
}
