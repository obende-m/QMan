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
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  BranchId,
  DEFAULT_TICKET_TEMPLATE,
  StationId,
  WorkflowId,
  type ConfigProblem,
  type DisplayBoardConfig,
  type HospitalConfiguration,
  type Permission,
  type StationConfig,
  type TicketTemplate,
  type Workflow,
} from "@qman/domain";
import type { ConfigurationWriter, EntityUsage } from "@qman/persistence";
import { requirePermission, tenantOf, type GuardDependencies } from "./authorization.js";
import type {
  ConfigurationChange,
  ConfigurationService,
  RoleChange,
} from "./configuration-service.js";
import { guard, record, type IdempotencyDependencies } from "./idempotency.js";
import type { Logger } from "./logging.js";
import { V1 } from "./version.js";

export interface ConfigWriteDependencies {
  readonly guards: GuardDependencies;
  readonly service: ConfigurationService;
  readonly writer: ConfigurationWriter;
  readonly logger: Logger;
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
      hospitalId: tenantOf(request),
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
      hospitalId: tenantOf(request),
      userId: authenticated.user.account.id,
      path: request.url,
      problems: result.problems.map((problem: ConfigProblem) => problem.path),
    });
    await respond(422, { error: "That change is not valid.", problems: result.problems });
    return;
  }

  deps.logger.info("configuration changed", {
    requestId: request.requestId,
    hospitalId: tenantOf(request),
    userId: authenticated.user.account.id,
    path: request.url,
  });

  await respond(200, {
    configuration: result.configuration,
    warnings: result.warnings,
  });
}

/**
 * Refuses a deletion that something still points at, and says what.
 *
 * Three foreign keys in the schema are `ON DELETE RESTRICT`, so attempting the
 * delete anyway would be safe — nothing is lost. But the caller receives a
 * constraint violation, which reaches an administrator as a 500 and tells them
 * nothing. Counting first turns it into an answer they can act on: this station
 * is used by two workflows and has served forty patients, so disable it.
 *
 * That advice is the important part. `enabled` already exists on a station
 * precisely because a station with history is meant to be retired, not removed:
 * deleting it would take its queue entries with it, and those are the record of
 * patients who were actually seen.
 */
function blockedBy(
  usage: readonly EntityUsage[],
  path: string,
  advice: string,
): ConfigProblem[] {
  if (usage.length === 0) return [];
  const described = usage
    .map(({ singular, plural, count }) => `${count} ${count === 1 ? singular : plural}`)
    .join(" and ");
  return [
    {
      path,
      message: `Still used by ${described}. ${advice}`,
      severity: "error",
    },
  ];
}

/**
 * The same orchestration for roles, which are validated by their own rule.
 *
 * Kept separate rather than folded into `applyChange` because the two validate
 * different things: a configuration against `validateHospitalConfiguration`,
 * and a role set against `validateRoles`. Merging them would mean one function
 * choosing which rule applies, which is the sort of branch that eventually
 * chooses wrong.
 */
async function applyRoleChange(
  deps: ConfigWriteDependencies,
  request: FastifyRequest,
  reply: FastifyReply,
  change: RoleChange,
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

  const result = await deps.service.applyToRoles(
    {
      hospitalId: tenantOf(request),
      actorId: authenticated.user.account.id,
      sessionId: authenticated.session.id,
      requestId: request.requestId,
      branchId: authenticated.session.branchId,
    },
    change,
  );

  if (!result.ok) {
    deps.logger.warn("role change rejected", {
      requestId: request.requestId,
      hospitalId: tenantOf(request),
      userId: authenticated.user.account.id,
      path: request.url,
    });
    await respond(422, { error: "That change is not valid.", problems: result.problems });
    return;
  }

  deps.logger.info("roles changed", {
    requestId: request.requestId,
    hospitalId: tenantOf(request),
    userId: authenticated.user.account.id,
    path: request.url,
  });

  await respond(200, { roles: result.roles });
}

export function registerConfigWriteRoutes(
  app: FastifyInstance,
  deps: ConfigWriteDependencies,
): void {
  const guarded = (permission: Permission) => ({
    preHandler: requirePermission(deps.guards, permission),
  });

  /**
   * Where a new entity is created.
   *
   * The branch comes from the body when given and from the hospital's default
   * otherwise, so a single-site hospital never has to name the branch it has
   * only one of.
   */
  const branchFor = (config: HospitalConfiguration, body: Record<string, unknown>): string => {
    const requested = typeof body["branchId"] === "string" ? body["branchId"] : null;
    if (requested !== null && config.branches.some((b) => b.id === requested)) return requested;
    return (config.branches.find((b) => b.isDefault) ?? config.branches[0])?.id ?? "";
  };

  app.post(`${V1}/stations`, guarded("admin.stations"), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    // Minted here, never accepted from the caller. A client choosing an
    // identifier could collide with an existing row, or resurrect a deleted one
    // and inherit its history.
    const id = StationId(randomUUID());

    await applyChange(deps, request, reply, {
      apply: (config) => ({
        ...config,
        stations: [
          ...config.stations,
          {
            id,
            name: patched(body, "name", ""),
            code: patched(body, "code", ""),
            room: patched(body, "room", null),
            staffing: patched(body, "staffing", 1),
            serviceEstimateMillis: patched(body, "serviceEstimateMillis", 600_000),
            sla: patched(body, "sla", { targetWaitMillis: 1_800_000, saturationPoint: 20 }),
            queueNumber: patched(body, "queueNumber", {
              template: "{n:3}",
              reset: "daily" as const,
            }),
            isPublic: patched(body, "isPublic", true),
            enabled: patched(body, "enabled", true),
          } as StationConfig,
        ],
      }),
      persist: async (tx, next, at) => {
        const created = station(next, id);
        if (created !== undefined) {
          await deps.writer.createStation(tx, branchFor(next, body), created, at);
        }
      },
      describe: (_before, after) => ({
        type: "config.station_added",
        summary: `Station ${station(after, id)?.name ?? id} added`,
        path: `stations.${id}`,
        before: null,
        after: station(after, id) ?? null,
      }),
    });
  });

  app.delete(`${V1}/stations/:id`, guarded("admin.stations"), async (request, reply) => {
    const { id } = request.params as { id: string };

    await applyChange(deps, request, reply, {
      precondition: async (tx) =>
        blockedBy(
          await deps.writer.stationUsage(tx, id),
          `stations.${id}`,
          "Disable the station instead: that stops it taking new patients and keeps the record of those it has already seen.",
        ),
      apply: (config) => ({
        ...config,
        stations: config.stations.filter((s) => s.id !== id),
      }),
      persist: (tx) => deps.writer.deleteStation(tx, id),
      describe: (before) => ({
        type: "config.station_updated",
        summary: `Station ${station(before, id)?.name ?? id} deleted`,
        path: `stations.${id}`,
        before: station(before, id) ?? null,
        after: null,
      }),
    });
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

  app.post(`${V1}/workflows`, guarded("admin.workflows"), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = WorkflowId(randomUUID());
    const find = (config: HospitalConfiguration) => config.workflows.find((w) => w.id === id);

    await applyChange(deps, request, reply, {
      apply: (config) => ({
        ...config,
        workflows: [
          ...config.workflows,
          {
            id,
            branchId: BranchId(branchFor(config, body)),
            name: patched(body, "name", ""),
            isDefault: patched(body, "isDefault", false),
            stages: patched(body, "stages", []),
          } as Workflow,
        ],
      }),
      persist: async (tx, next, at) => {
        const created = find(next);
        if (created !== undefined) {
          await deps.writer.createWorkflow(tx, branchFor(next, body), created, at);
        }
      },
      describe: (_before, after) => ({
        type: "config.workflow_updated",
        summary: `Workflow ${find(after)?.name ?? id} added`,
        path: `workflows.${id}`,
        before: null,
        after: find(after) ?? null,
      }),
    });
  });

  app.delete(`${V1}/workflows/:id`, guarded("admin.workflows"), async (request, reply) => {
    const { id } = request.params as { id: string };
    const find = (config: HospitalConfiguration) => config.workflows.find((w) => w.id === id);

    await applyChange(deps, request, reply, {
      precondition: async (tx) =>
        blockedBy(
          await deps.writer.workflowUsage(tx, id),
          `workflows.${id}`,
          "Visits already recorded against it would lose the path they were sent down.",
        ),
      apply: (config) => ({
        ...config,
        workflows: config.workflows.filter((w) => w.id !== id),
      }),
      persist: (tx) => deps.writer.deleteWorkflow(tx, id),
      describe: (before) => ({
        type: "config.workflow_updated",
        summary: `Workflow ${find(before)?.name ?? id} deleted`,
        path: `workflows.${id}`,
        before: find(before) ?? null,
        after: null,
      }),
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

  app.post(`${V1}/display-boards`, guarded("admin.display_boards"), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = randomUUID();
    const find = (config: HospitalConfiguration) => config.displayBoards.find((b) => b.id === id);

    await applyChange(deps, request, reply, {
      apply: (config) => ({
        ...config,
        displayBoards: [
          ...config.displayBoards,
          {
            id,
            name: patched(body, "name", ""),
            stationIds: (patched(body, "stationIds", []) as readonly string[]).map((value) =>
              StationId(value),
            ),
            waitingToShow: patched(body, "waitingToShow", 4),
            // A new public screen starts at the most private setting. Showing
            // names should be something an administrator chooses, never
            // something a board happens to be created with.
            namePolicy: patched(body, "namePolicy", "ticket_only"),
            showEstimatedWait: patched(body, "showEstimatedWait", true),
            showRoom: patched(body, "showRoom", true),
          } as DisplayBoardConfig,
        ],
      }),
      persist: async (tx, next, at) => {
        const created = find(next);
        if (created !== undefined) {
          await deps.writer.createBoard(tx, branchFor(next, body), created, at);
        }
      },
      describe: (_before, after) => ({
        type: "config.display_board_updated",
        summary: `Display board ${find(after)?.name ?? id} added`,
        path: `displayBoards.${id}`,
        before: null,
        after: find(after) ?? null,
      }),
    });
  });

  /**
   * A board holds no history and nothing references it, so there is no
   * reference check: removing one takes a screen out of service and loses
   * nothing that happened.
   */
  app.delete(
    `${V1}/display-boards/:id`,
    guarded("admin.display_boards"),
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const find = (config: HospitalConfiguration) =>
        config.displayBoards.find((b) => b.id === id);

      await applyChange(deps, request, reply, {
        apply: (config) => ({
          ...config,
          displayBoards: config.displayBoards.filter((b) => b.id !== id),
        }),
        persist: (tx) => deps.writer.deleteBoard(tx, id),
        describe: (before) => ({
          type: "config.display_board_updated",
          summary: `Display board ${find(before)?.name ?? id} deleted`,
          path: `displayBoards.${id}`,
          before: find(before) ?? null,
          after: null,
        }),
      });
    },
  );

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

  app.post(`${V1}/ticket-templates`, guarded("admin.settings"), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = randomUUID();
    const find = (config: HospitalConfiguration) =>
      config.ticketTemplates.find((t) => t.id === id);

    await applyChange(deps, request, reply, {
      apply: (config) => ({
        ...config,
        ticketTemplates: [
          ...config.ticketTemplates,
          {
            id,
            name: patched(body, "name", ""),
            paper: patched(body, "paper", "thermal_80mm"),
            elements: patched(body, "elements", DEFAULT_TICKET_TEMPLATE.elements),
            instructions: patched(body, "instructions", ""),
            footer: patched(body, "footer", ""),
            namePolicy: patched(body, "namePolicy", "ticket_only"),
            trackingUrl: patched(body, "trackingUrl", DEFAULT_TICKET_TEMPLATE.trackingUrl),
          } as TicketTemplate,
        ],
      }),
      persist: async (tx, next, at) => {
        const created = find(next);
        if (created !== undefined) {
          await deps.writer.createTicketTemplate(
            tx,
            tenantOf(request),
            created,
            at,
          );
        }
      },
      describe: (_before, after) => ({
        type: "config.ticket_template_updated",
        summary: `Ticket template ${find(after)?.name ?? id} added`,
        path: `ticketTemplates.${id}`,
        before: null,
        after: find(after) ?? null,
      }),
    });
  });

  /**
   * No reference check. Deleting the template a hospital defaults to is already
   * refused by `validateHospitalConfiguration`, which requires the default to
   * exist — the rule is the domain's and duplicating it here would give it two
   * places to disagree with itself.
   */
  app.delete(`${V1}/ticket-templates/:id`, guarded("admin.settings"), async (request, reply) => {
    const { id } = request.params as { id: string };
    const find = (config: HospitalConfiguration) =>
      config.ticketTemplates.find((t) => t.id === id);

    await applyChange(deps, request, reply, {
      apply: (config) => ({
        ...config,
        ticketTemplates: config.ticketTemplates.filter((t) => t.id !== id),
      }),
      persist: (tx) =>
        deps.writer.deleteTicketTemplate(tx, tenantOf(request), id),
      describe: (before) => ({
        type: "config.ticket_template_updated",
        summary: `Ticket template ${find(before)?.name ?? id} deleted`,
        path: `ticketTemplates.${id}`,
        before: find(before) ?? null,
        after: null,
      }),
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
            tenantOf(request),
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

  // ───────────────────────────────────────────────────────────── roles

  app.post(`${V1}/roles`, guarded("admin.users"), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = randomUUID();

    await applyRoleChange(deps, request, reply, {
      apply: (roles) => [
        ...roles,
        {
          id,
          name: patched(body, "name", ""),
          description: patched(body, "description", ""),
          permissions: patched(body, "permissions", []),
          // Only roles that ship with QMan are system roles. One created here
          // never is, or a hospital could manufacture undeletable roles.
          isSystem: false,
        },
      ],
      persist: async (tx, next, at) => {
        const created = next.find((role) => role.id === id);
        if (created !== undefined) {
          await deps.writer.createRole(tx, tenantOf(request), created, at);
        }
      },
      describe: (_before, after) => ({
        type: "config.role_created",
        summary: `Role ${after.find((r) => r.id === id)?.name ?? id} added`,
        path: `roles.${id}`,
        before: null,
        after: after.find((r) => r.id === id) ?? null,
      }),
    });
  });

  app.patch(`${V1}/roles/:id`, guarded("admin.users"), async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;

    await applyRoleChange(deps, request, reply, {
      apply: (roles) =>
        roles.map((role) =>
          role.id === id
            ? {
                ...role,
                name: patched(body, "name", role.name),
                description: patched(body, "description", role.description),
                permissions: patched(body, "permissions", role.permissions),
              }
            : role,
        ),
      persist: async (tx, next, at) => {
        const updated = next.find((role) => role.id === id);
        if (updated !== undefined) {
          await deps.writer.updateRole(tx, tenantOf(request), updated, at);
        }
      },
      /**
       * A permission change is the one worth finding later. "Who gave the
       * reception role the ability to change SLAs" is the question, and it is
       * answerable only if the grant is recorded on both sides.
       */
      describe: (before, after) => ({
        type: "config.role_updated",
        summary: `Role ${after.find((r) => r.id === id)?.name ?? id} permissions updated`,
        path: `roles.${id}`,
        before: before.find((r) => r.id === id)?.permissions ?? null,
        after: after.find((r) => r.id === id)?.permissions ?? null,
      }),
    });
  });

  app.delete(`${V1}/roles/:id`, guarded("admin.users"), async (request, reply) => {
    const { id } = request.params as { id: string };

    await applyRoleChange(deps, request, reply, {
      precondition: async (tx) => {
        const held = blockedBy(
          await deps.writer.roleUsage(tx, id),
          `roles.${id}`,
          "Move them to another role first.",
        );
        return held;
      },
      /**
       * A system role is filtered out of the change rather than deleted, so the
       * set validation sees it survive and the write is a no-op. Built-in roles
       * exist so a hospital cannot remove every administrative role and lock
       * itself out; the database refuses it too.
       */
      apply: (roles) => roles.filter((role) => role.id !== id || role.isSystem),
      persist: (tx) => deps.writer.deleteRole(tx, tenantOf(request), id),
      describe: (before) => ({
        type: "config.role_deleted",
        summary: `Role ${before.find((r) => r.id === id)?.name ?? id} deleted`,
        path: `roles.${id}`,
        before: before.find((r) => r.id === id) ?? null,
        after: null,
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
        deps.writer.updateDefaults(tx, tenantOf(request), next.defaults, at),
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
