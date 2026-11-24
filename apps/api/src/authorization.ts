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
}

/**
 * The tenant this request acts within.
 *
 * Read from the authenticated session and from nowhere else. No route takes a
 * hospital id as a path parameter, a query parameter or a body field, so a
 * client has no way to name a tenant at all — reaching another organization's
 * data is not refused, it is unrepresentable.
 *
 * Throws rather than returning null. Every caller runs after a guard that has
 * already authenticated; reaching here without a session is a programming
 * error, and returning a nullable would invite a caller to handle it by
 * defaulting to something.
 */
export function tenantOf(request: FastifyRequest): string {
  const authenticated = request.authenticated;
  if (authenticated === undefined) {
    throw new Error("tenantOf called on an unauthenticated request.");
  }
  return authenticated.hospitalId;
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
 * Refuses a request whose target belongs to another organization.
 *
 * This is the defence-in-depth control described in ADR/PLATFORM-TENANCY §6.2,
 * and it is permanent. Tenancy is derived from the session (`tenantOf`), so in
 * a correct system this comparison always passes — which is exactly why it is
 * worth making. The two quantities have different provenance: the session's
 * hospital comes from the `users` row, and the owner's comes from the resource
 * that was actually loaded. They can only disagree if a repository returned a
 * row it should not have.
 *
 * That is the failure it catches: a query written without its
 * `WHERE hospital_id = $1`, or a lookup by an id that turned out to belong to
 * someone else. Without this, such a bug serves another hospital's data with a
 * 200; with it, the request fails closed and the log carries an alarm.
 *
 * `null` means the resource was not found. That is refused too, and with the
 * same message: telling an unauthorised caller apart from an unlucky one tells
 * them whether the id they guessed exists.
 */
export function ownedByTenant(
  deps: GuardDependencies,
  request: FastifyRequest,
  reply: FastifyReply,
  ownerHospitalId: string | null,
  resource: string,
): boolean {
  const authenticated = request.authenticated!;

  if (ownerHospitalId === null || ownerHospitalId !== authenticated.hospitalId) {
    deps.logger.error("cross-tenant request refused", {
      requestId: request.requestId,
      path: request.url,
      userId: authenticated.user.account.id,
      resource,
      hospitalId: authenticated.hospitalId,
      ownerHospitalId,
    });
    void reply.status(404).send({ error: `No such ${resource}.` });
    return false;
  }

  return true;
}

/**
 * A preHandler enforcing one permission.
 *
 * The tenant is not checked here any more, because there is nothing to check it
 * against: it comes from the session and the session is the only source. What
 * replaces that check is `ownedByTenant`, applied where a resource is loaded —
 * see §6.2. Moving it there is not a relaxation; it is pointing the same
 * refusal at a comparison that can still fail.
 */
export function requirePermission(deps: GuardDependencies, permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!(await authenticate(deps, request, reply))) return;

    const authenticated = request.authenticated!;

    /*
     * A temporary password unlocks one thing: replacing itself.
     *
     * It was read out over the phone or printed by provisioning, so someone
     * other than its holder knows it. Until it is changed, every permissioned
     * route refuses, and says why so the client can show the change form
     * instead of a wall of "permission denied".
     */
    if (authenticated.passwordChangeRequired === true) {
      void reply.status(403).send({
        error: "Choose a new password before continuing.",
        reason: "password_change_required",
      });
      return;
    }

    if (!authenticated.user.permissions.includes(permission)) {
      deps.logger.warn("permission refused", {
        requestId: request.requestId,
        path: request.url,
        hospitalId: authenticated.hospitalId,
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
