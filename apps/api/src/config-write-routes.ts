/**
 * Configuration writes.
 *
 * Every handler does the same thing: read the patch, build a pure function that
 * produces the configuration that should result, and hand it to the service.
 * None of them validates, and none of them contains SQL. What a handler knows
 * is which fields a route may change and which permission it requires; whether
 * the result is a legal configuration is the domain's answer, given once.
 *
 * **Routing follows the entities, not the settings screens.** There is no
 * `/slas` or `/privacy` endpoint, though both were suggested, because an SLA is
 * a property of a station and a privacy policy is a property of a board, a
 * ticket template or the hospital default. Routes for them would be second
 * paths writing columns that `/stations/:id` and `/display-boards/:id` already
 * own — two ways to change one value, which is the shape that produces "the
 * screen says thirty minutes and the database says twenty".
 *
 * **Patches are partial and explicit.** A field absent from the body is left
 * alone; a field present replaces. Accepting a whole entity would make every
 * save a last-write-wins overwrite of fields the caller never looked at.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  StationId,
  type ConfigProblem,
  type DisplayBoardConfig,
  type HospitalConfiguration,
  type Permission,
  type StationConfig,
  type Workflow,
} from "@qman/domain";
import type { ConfigurationWriter } from "@qman/persistence";
import { requirePermission, type GuardDependencies } from "./authorization.js";
import type { ConfigurationChange, ConfigurationService } from "./configuration-service.js";
import { guard, record, type IdempotencyDependencies } from "./idempotency.js";
import type { Logger } from "./logging.js";
import { V1 } from "./version.js";

export interface ConfigWriteDependencies {
  readonly guards: GuardDependencies;
  readonly service: ConfigurationService;
  readonly writer: ConfigurationWriter;
  readonly logger: Logger;
  readonly resolveHospital: (request: FastifyRequest) => string;
  readonly idempotency?: IdempotencyDependencies;
}

/** Reads a field from a patch, leaving it alone when absent. */
function patched<T>(body: Record<string, unknown>, key: string, current: T): T {
  return key in body ? (body[key] as T) : current;
}

function station(config: HospitalConfiguration, id: string): StationConfig | undefined {
  return config.stations.find((s) => s.id === id);
}

/**
 * Runs a change and answers.
 *
 * A rejected configuration is 422, not 400: the request was well-formed and the
 * caller was entitled to make it, and what failed was the resulting state
 * rather than the syntax. The problems come back as the domain reported them,
 * so the administration portal can point at the field.
 */
async function applyChange(
  deps: ConfigWriteDependencies,
  request: FastifyRequest,
  reply: FastifyReply,
  change: ConfigurationChange,
): Promise<void> {
  const guarded = deps.idempotency
    ? await guard(deps.idempotency, request, reply)
    : ({ proceed: true, key: null } as const);
  if (!guarded.proceed) return;

  const authenticated = request.authenticated!;
  const respond = async (status: number, payload: unknown): Promise<void> => {
    if (deps.idempotency) {
      await record(deps.idempotency, request, guarded.key, status, payload);
    }
    void reply.status(status).send(payload);
  };

  const result = await deps.service.apply(
    {
      hospitalId: deps.resolveHospital(request),
      actorId: authenticated.user.account.id,
      sessionId: authenticated.session.id,
      requestId: request.requestId,
      branchId: authenticated.session.branchId,
    },
    change,
  );

  if (!result.ok) {
    deps.logger.warn("configuration change rejected", {
      requestId: request.requestId,
      hospitalId: deps.resolveHospital(request),
      userId: authenticated.user.account.id,
      path: request.url,
      problems: result.problems.map((problem: ConfigProblem) => problem.path),
    });
    await respond(422, { error: "That change is not valid.", problems: result.problems });
    return;
  }

  deps.logger.info("configuration changed", {
    requestId: request.requestId,
    hospitalId: deps.resolveHospital(request),
    userId: authenticated.user.account.id,
    path: request.url,
  });

  await respond(200, {
    configuration: result.configuration,
    warnings: result.warnings,
  });
}

export function registerConfigWriteRoutes(
  app: FastifyInstance,
  deps: ConfigWriteDependencies,
): void {
  const guarded = (permission: Permission) => ({
    preHandler: requirePermission(deps.guards, permission),
  });

  app.patch(`${V1}/stations/:id`, guarded("admin.stations"), async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;

    await applyChange(deps, request, reply, {
      apply: (config) => ({
        ...config,
        stations: config.stations.map((current) =>
          current.id === id
            ? {
                ...current,
                name: patched(body, "name", current.name),
                code: patched(body, "code", current.code),
                room: patched(body, "room", current.room),
                staffing: patched(body, "staffing", current.staffing),
                serviceEstimateMillis: patched(
                  body,
                  "serviceEstimateMillis",
                  current.serviceEstimateMillis,
                ),
                sla: patched(body, "sla", current.sla),
                queueNumber: patched(body, "queueNumber", current.queueNumber),
                isPublic: patched(body, "isPublic", current.isPublic),
                enabled: patched(body, "enabled", current.enabled),
              }
            : current,
        ),
      }),
      persist: async (tx, next, at) => {
        const updated = station(next, id);
        if (updated !== undefined) await deps.writer.updateStation(tx, updated, at);
      },
      /**
       * The specific change is named rather than "a station was updated". The
       * question asked months later is "who changed this SLA", and an entry
       * that cannot answer it is an entry nobody reads.
       */
      describe: (before, after) => {
        const was = station(before, id);
        const now = station(after, id);
        const name = now?.name ?? was?.name ?? id;

        if ("sla" in body) {
          return {
            type: "config.sla_updated",
            summary: `SLA for ${name} set to a ${Math.round(
              (now?.sla.targetWaitMillis ?? 0) / 60_000,
            )} minute target`,
            path: `stations.${id}.sla`,
            before: was?.sla ?? null,
            after: now?.sla ?? null,
          };
        }
        if ("queueNumber" in body) {
          return {
            type: "config.queue_numbering_updated",
            summary: `Queue numbering for ${name} set to "${now?.queueNumber.template ?? ""}" (${
              now?.queueNumber.reset ?? ""
            })`,
            path: `stations.${id}.queueNumber`,
            before: was?.queueNumber ?? null,
            after: now?.queueNumber ?? null,
          };
        }
        return {
          type: "config.station_updated",
          summary: `Station ${name} updated`,
          path: `stations.${id}`,
          before: was ?? null,
          after: now ?? null,
        };
      },
    });
  });

  app.patch(`${V1}/workflows/:id`, guarded("admin.workflows"), async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const find = (config: HospitalConfiguration): Workflow | undefined =>
      config.workflows.find((w) => w.id === id);

    await applyChange(deps, request, reply, {
      apply: (config) => ({
        ...config,
        workflows: config.workflows.map((current) =>
          current.id === id
            ? {
                ...current,
                name: patched(body, "name", current.name),
                isDefault: patched(body, "isDefault", current.isDefault),
                stages: patched(body, "stages", current.stages),
              }
            : current,
        ),
      }),
      persist: async (tx, next, at) => {
        const updated = find(next);
        if (updated !== undefined) await deps.writer.updateWorkflow(tx, updated, at);
      },
      describe: (before, after) => ({
        type: "config.workflow_updated",
        summary: `Workflow ${find(after)?.name ?? id} updated`,
        path: `workflows.${id}`,
        before: find(before) ?? null,
        after: find(after) ?? null,
      }),
    });
  });

  app.patch(`${V1}/display-boards/:id`, guarded("admin.display_boards"), async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const find = (config: HospitalConfiguration): DisplayBoardConfig | undefined =>
      config.displayBoards.find((b) => b.id === id);

    await applyChange(deps, request, reply, {
      apply: (config) => ({
        ...config,
        displayBoards: config.displayBoards.map((current) =>
          current.id === id
            ? {
                ...current,
                name: patched(body, "name", current.name),
                stationIds: (
                  patched(body, "stationIds", current.stationIds) as readonly string[]
                ).map((value) => StationId(value)),
                waitingToShow: patched(body, "waitingToShow", current.waitingToShow),
                namePolicy: patched(body, "namePolicy", current.namePolicy),
                showEstimatedWait: patched(body, "showEstimatedWait", current.showEstimatedWait),
                showRoom: patched(body, "showRoom", current.showRoom),
              }
            : current,
        ),
      }),
      persist: async (tx, next, at) => {
        const updated = find(next);
        if (updated !== undefined) await deps.writer.updateBoard(tx, updated, at);
      },
      /**
       * A change to what a public screen may display is recorded as a privacy
       * change, not as a board edit. It is the entry someone will search for.
       */
      describe: (before, after) => {
        const was = find(before);
        const now = find(after);
        if ("namePolicy" in body && was?.namePolicy !== now?.namePolicy) {
          return {
            type: "config.privacy_updated",
            summary: `Display board ${now?.name ?? id} name policy set to ${now?.namePolicy ?? ""}`,
            path: `displayBoards.${id}.namePolicy`,
            before: was?.namePolicy ?? null,
            after: now?.namePolicy ?? null,
          };
        }
        return {
          type: "config.display_board_updated",
          summary: `Display board ${now?.name ?? id} updated`,
          path: `displayBoards.${id}`,
          before: was ?? null,
          after: now ?? null,
        };
      },
    });
  });

  app.patch(`${V1}/ticket-templates/:id`, guarded("admin.settings"), async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const find = (config: HospitalConfiguration) =>
      config.ticketTemplates.find((t) => t.id === id);

    await applyChange(deps, request, reply, {
      apply: (config) => ({
        ...config,
        ticketTemplates: config.ticketTemplates.map((current) =>
          current.id === id
            ? {
                ...current,
                name: patched(body, "name", current.name),
                paper: patched(body, "paper", current.paper),
                elements: patched(body, "elements", current.elements),
                instructions: patched(body, "instructions", current.instructions),
                footer: patched(body, "footer", current.footer),
                namePolicy: patched(body, "namePolicy", current.namePolicy),
                trackingUrl: patched(body, "trackingUrl", current.trackingUrl),
              }
            : current,
        ),
      }),
      persist: async (tx, next, at) => {
        const updated = find(next);
        if (updated !== undefined) {
          await deps.writer.updateTicketTemplate(
            tx,
            deps.resolveHospital(request),
            updated,
            at,
          );
        }
      },
      describe: (before, after) => ({
        type: "config.ticket_template_updated",
        summary: `Ticket template ${find(after)?.name ?? id} updated`,
        path: `ticketTemplates.${id}`,
        before: find(before) ?? null,
        after: find(after) ?? null,
      }),
    });
  });

  app.patch(`${V1}/profile`, guarded("admin.settings"), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    await applyChange(deps, request, reply, {
      apply: (config) => ({
        ...config,
        profile: {
          ...config.profile,
          name: patched(body, "name", config.profile.name),
          code: patched(body, "code", config.profile.code),
          timezone: patched(body, "timezone", config.profile.timezone),
          supportPhone: patched(body, "supportPhone", config.profile.supportPhone),
          brandColor: patched(body, "brandColor", config.profile.brandColor),
        },
      }),
      persist: (tx, next, at) => deps.writer.updateProfile(tx, next.profile, at),
      describe: (before, after) => ({
        type: "config.profile_updated",
        summary: `Hospital profile updated`,
        path: "profile",
        before: before.profile,
        after: after.profile,
      }),
    });
  });

  /**
   * The hospital-wide defaults: the name policy applied where nothing overrides
   * it, and the ticket template used by stations that name none.
   */
  app.patch(`${V1}/settings`, guarded("admin.settings"), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    await applyChange(deps, request, reply, {
      apply: (config) => ({
        ...config,
        defaults: {
          namePolicy: patched(body, "namePolicy", config.defaults.namePolicy),
          ticketTemplateId: patched(
            body,
            "ticketTemplateId",
            config.defaults.ticketTemplateId,
          ),
        },
      }),
      persist: (tx, next, at) =>
        deps.writer.updateDefaults(tx, deps.resolveHospital(request), next.defaults, at),
      describe: (before, after) => {
        if (before.defaults.namePolicy !== after.defaults.namePolicy) {
          return {
            type: "config.privacy_updated",
            summary: `Default patient name policy set to ${after.defaults.namePolicy}`,
            path: "defaults.namePolicy",
            before: before.defaults.namePolicy,
            after: after.defaults.namePolicy,
          };
        }
        return {
          type: "config.ticket_template_updated",
          summary: `Default ticket template changed`,
          path: "defaults.ticketTemplateId",
          before: before.defaults.ticketTemplateId,
          after: after.defaults.ticketTemplateId,
        };
      },
    });
  });
}
