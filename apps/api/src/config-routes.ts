/**
 * The configuration endpoint.
 *
 * One read, returning the whole configuration, because that is how it is used:
 * every surface needs stations to render a queue, workflows to offer a route,
 * and the name policy to decide what it may display. Splitting it into a
 * resource per table would turn one page load into six round trips and give a
 * screen the chance to render against a half-loaded configuration.
 *
 * The handler is deliberately thin. It loads, asks the domain whether the
 * configuration is sound, and returns both. The rules that decide *what* sound
 * means live in `validateHospitalConfiguration`, and the administration portal
 * shows the same problems from the same function — there is one definition of a
 * misconfigured hospital, not one per surface.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { validateHospitalConfiguration } from "@qman/domain";
import type { ConfigurationRepository } from "@qman/persistence";
import {
  requirePermission,
  requireSignedIn,
  tenantOf,
  type GuardDependencies,
} from "./authorization.js";
import type { Logger } from "./logging.js";
import { V1 } from "./version.js";

export interface ConfigRouteDependencies {
  readonly guards: GuardDependencies;
  readonly configuration: ConfigurationRepository;
  readonly logger: Logger;
}

export function registerConfigRoutes(
  app: FastifyInstance,
  deps: ConfigRouteDependencies,
): void {
  /**
   * Available to any signed-in member of staff rather than gated behind an
   * administration permission.
   *
   * A receptionist cannot work without knowing the stations, and refusing them
   * the configuration would mean every screen needed its own copy — which is
   * the duplication this endpoint exists to remove. Changing configuration is a
   * different matter and carries its own permissions.
   */
  app.get(
    `${V1}/config`,
    { preHandler: requireSignedIn(deps.guards) },
    async (request, reply) => {
      const hospitalId = tenantOf(request);
      const configuration = await deps.configuration.load(hospitalId);

      if (configuration === null) {
        deps.logger.error("configured hospital does not exist", {
          requestId: request.requestId,
          hospitalId,
        });
        return reply.status(500).send({
          error: "This server is configured for a hospital that does not exist.",
          requestId: request.requestId,
        });
      }

      return reply.status(200).send({
        configuration,
        // Returned with the configuration rather than from a second endpoint,
        // so a surface cannot render a configuration without also having been
        // told what is wrong with it.
        problems: validateHospitalConfiguration(configuration),
      });
    },
  );

  /**
   * The roles a hospital has defined.
   *
   * Separate from the configuration because it is needed by one screen rather
   * than by all of them, and because it is administrative: a receptionist has
   * no reason to enumerate who can do what.
   */
  app.get(
    `${V1}/roles`,
    { preHandler: requirePermission(deps.guards, "admin.users") },
    async (request, reply) => {
      const roles = await deps.configuration.loadRoles(tenantOf(request));
      return reply.status(200).send({ roles });
    },
  );
}
