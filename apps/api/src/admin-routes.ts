/**
 * Account, session and branch administration.
 *
 * What an organization's administrator needs in order to run QMan without a
 * support engineer: add a member of staff, change what they may do and where,
 * withdraw their access the day they leave, reset a forgotten password, see who
 * is signed in and end a session left open on a shared workstation, and add a
 * branch.
 *
 * Four rules hold throughout.
 *
 * - **Everything is scoped to the caller's organization in SQL.** A user, a
 *   session and a branch are all addressed by an id from the URL; the
 *   repository applies the tenant, so another organization's id matches
 *   nothing and is answered 404.
 * - **Every change is audited in the same transaction.** An access change with
 *   no record of who made it is the change an investigation most needs to
 *   explain.
 * - **Nobody can lock the organization out.** The last enabled account able to
 *   manage users cannot be disabled or moved to a role without that ability,
 *   and an administrator cannot disable their own account.
 * - **Generated passwords are shown once and must be replaced.** They are
 *   returned in the response that created them, never stored or logged, and
 *   the account can do nothing else until its holder chooses their own.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { checkPassword, categoryOf, type Permission } from "@qman/domain";
import type {
  AccountRepository,
  AdministrationRepository,
  Database,
  NewEvent,
  SqlExecutor,
} from "@qman/persistence";
import { appendEvents } from "@qman/persistence";
import { requirePermission, requireSignedIn, tenantOf, type GuardDependencies } from "./authorization.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { generatePassword } from "./tokens.js";
import { isUuid } from "./identifiers.js";
import type { Logger } from "./logging.js";
import { V1 } from "./version.js";

export interface AdministrationRouteDependencies {
  readonly guards: GuardDependencies;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly db: Database;
  readonly administration: AdministrationRepository;
  /** For verifying a password the caller says is theirs. */
  readonly accounts: AccountRepository;
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,63}$/i;
const BRANCH_CODE = /^[a-z0-9][a-z0-9-]{0,15}$/i;

/** One audit record, for the organization, attributed to the caller's sitting. */
export function auditRecord(
  request: FastifyRequest,
  type: string,
  summary: string,
  payload: Record<string, unknown>,
  at: Date,
): NewEvent {
  const authenticated = request.authenticated!;
  return {
    hospitalId: tenantOf(request) as NewEvent["hospitalId"],
    // Organization-level: administrative records carry no branch (migration 012).
    branchId: null as unknown as NewEvent["branchId"],
    category: categoryOf(type),
    type,
    visitId: null,
    correlationId: authenticated.session.id,
    actorId: authenticated.user.account.id,
    occurredAt: at,
    payload,
    summary,
  };
}

function describeUserSummary(user: Awaited<ReturnType<AdministrationRepository["listUsers"]>>[number]) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    roleId: user.roleId,
    roleName: user.roleName,
    branchIds: user.branchIds,
    enabled: user.enabled,
    providerId: user.providerId,
    passwordChangeRequired: user.passwordChangeRequired,
    lastSignInAt: user.lastSignInAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    lockedUntil: user.lockedUntil?.toISOString() ?? null,
  };
}

/** Reads an optional list of branch ids, refusing anything that is not one. */
function branchList(value: unknown): { ok: true; value: string[] | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value) || value.length > 100 || !value.every(isUuid)) return { ok: false };
  return { ok: true, value: [...new Set(value as string[])] };
}

export function registerAdministrationRoutes(
  app: FastifyInstance,
  deps: AdministrationRouteDependencies,
): void {
  const guarded = (permission: Permission) => ({
    preHandler: requirePermission(deps.guards, permission),
  });
  const repo = deps.administration;

  /** Runs a write and its audit records in one transaction. */
  const write = <T>(work: (tx: SqlExecutor, audit: (records: NewEvent[]) => Promise<void>) => Promise<T>) =>
    deps.db.transaction((tx) => work(tx, (records) => appendEvents(tx, records)));

  const refuse = (reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}) =>
    reply.status(status).send({ error, ...extra });

  // ─────────────────────────────────────────────────────────────── users

  app.get(`${V1}/users`, guarded("admin.users"), async (request, reply) => {
    const users = await repo.listUsers(tenantOf(request));
    return reply.status(200).send({ users: users.map(describeUserSummary) });
  });

  /**
   * Who is who, for dashboards and the activity log.
   *
   * A manager's workload panel and the audit log name the staff who acted.
   * They need a name for an id and nothing else, so this answers with exactly
   * that — no usernames, roles, branches or sign-in history, which are the
   * account administrator's business.
   */
  app.get(`${V1}/staff`, guarded("reports.view"), async (request, reply) => {
    const users = await repo.listUsers(tenantOf(request));
    return reply.status(200).send({
      staff: users.map((user) => ({ id: user.id, displayName: user.displayName })),
    });
  });

  app.post(`${V1}/users`, guarded("admin.users"), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const hospitalId = tenantOf(request);

    const username = typeof body["username"] === "string" ? body["username"].trim() : "";
    if (!USERNAME.test(username)) {
      return refuse(reply, 422, "A username is 3 to 64 letters, digits, dots, dashes or underscores.");
    }
    const displayName = typeof body["displayName"] === "string" ? body["displayName"].trim() : "";
    if (displayName === "" || displayName.length > 120) {
      return refuse(reply, 422, "A display name is required, up to 120 characters.");
    }
    const roleId = body["roleId"];
    if (!isUuid(roleId)) return refuse(reply, 422, "Choose a role.");
    const branches = branchList(body["branchIds"]);
    if (!branches.ok) return refuse(reply, 422, "Branches must be a list of branch ids.");

    if ((await repo.rolePermissions(hospitalId, roleId)) === null) {
      return refuse(reply, 422, "That role does not exist.");
    }
    if (!(await repo.branchesBelong(hospitalId, branches.value ?? []))) {
      return refuse(reply, 422, "One of those branches does not exist.");
    }
    if (await repo.isUsernameTaken(hospitalId, username)) {
      return refuse(reply, 409, "That username is already in use.");
    }

    const password = generatePassword();
    const hashed = await hashPassword(password);
    const at = deps.now();

    const id = await write(async (tx, audit) => {
      const created = await repo.createUser(
        tx,
        hospitalId,
        {
          username,
          displayName,
          roleId,
          branchIds: branches.value ?? [],
          passwordHash: hashed.hash,
          passwordSalt: hashed.salt,
        },
        at,
      );
      await audit([
        auditRecord(request, "admin.user_created", `Account ${username} created`, {
          userId: created,
          username,
          roleId,
          branchIds: branches.value ?? [],
        }, at),
      ]);
      return created;
    });

    deps.logger.info("account created", { requestId: request.requestId, hospitalId, userId: id });
    const user = await repo.findUser(hospitalId, id);
    // The password is in this response and nowhere else.
    return reply.status(201).send({ user: user && describeUserSummary(user), temporaryPassword: password });
  });

  app.patch(`${V1}/users/:id`, guarded("admin.users"), async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return refuse(reply, 400, "That identifier is not valid.");
    const body = (request.body ?? {}) as Record<string, unknown>;
    const hospitalId = tenantOf(request);
    const caller = request.authenticated!;

    const existing = await repo.findUser(hospitalId, id);
    if (existing === null) return refuse(reply, 404, "No such account.");

    const changes: { displayName?: string; roleId?: string; branchIds?: string[]; enabled?: boolean } = {};
    if ("displayName" in body) {
      const name = typeof body["displayName"] === "string" ? body["displayName"].trim() : "";
      if (name === "" || name.length > 120) return refuse(reply, 422, "A display name is required, up to 120 characters.");
      changes.displayName = name;
    }
    if ("roleId" in body) {
      if (!isUuid(body["roleId"])) return refuse(reply, 422, "Choose a role.");
      changes.roleId = body["roleId"];
    }
    if ("branchIds" in body) {
      const branches = branchList(body["branchIds"]);
      if (!branches.ok || branches.value === undefined) return refuse(reply, 422, "Branches must be a list of branch ids.");
      if (!(await repo.branchesBelong(hospitalId, branches.value))) {
        return refuse(reply, 422, "One of those branches does not exist.");
      }
      changes.branchIds = branches.value;
    }
    if ("enabled" in body) {
      if (typeof body["enabled"] !== "boolean") return refuse(reply, 422, "enabled must be true or false.");
      changes.enabled = body["enabled"];
    }
    if (Object.keys(changes).length === 0) return refuse(reply, 400, "Nothing to change.");

    if (changes.enabled === false && id === caller.user.account.id) {
      return refuse(reply, 409, "You cannot disable your own account.");
    }

    let newRolePermissions: Permission[] | null = null;
    if (changes.roleId !== undefined) {
      newRolePermissions = await repo.rolePermissions(hospitalId, changes.roleId);
      if (newRolePermissions === null) return refuse(reply, 422, "That role does not exist.");
    }

    // Would this leave nobody able to manage users?
    const losesAdministration =
      changes.enabled === false ||
      (newRolePermissions !== null && !newRolePermissions.includes("admin.users"));
    if (losesAdministration && (await repo.countUserAdministrators(hospitalId, id)) === 0) {
      const current = await repo.rolePermissions(hospitalId, existing.roleId);
      if (existing.enabled && current?.includes("admin.users")) {
        return refuse(reply, 409, "This is the last account able to manage users. Give that ability to someone else first.");
      }
    }

    const at = deps.now();
    await write(async (tx, audit) => {
      const updated = await repo.updateUser(tx, hospitalId, id, changes, at);
      if (!updated) return;
      const records: NewEvent[] = [];
      if (changes.roleId !== undefined && changes.roleId !== existing.roleId) {
        records.push(auditRecord(request, "auth.role_changed", `Role of ${existing.username} changed`, {
          userId: id,
          before: existing.roleId,
          after: changes.roleId,
        }, at));
      }
      if (changes.enabled !== undefined && changes.enabled !== existing.enabled) {
        records.push(auditRecord(
          request,
          changes.enabled ? "admin.user_enabled" : "admin.user_disabled",
          `Account ${existing.username} ${changes.enabled ? "enabled" : "disabled"}`,
          { userId: id },
          at,
        ));
        if (!changes.enabled) {
          // Withdrawn access ends now, not at the next session timeout.
          await repo.endSessionsForUser(tx, hospitalId, id, "terminated_by_admin", at);
        }
      }
      if (changes.displayName !== undefined || changes.branchIds !== undefined) {
        records.push(auditRecord(request, "admin.user_updated", `Account ${existing.username} updated`, {
          userId: id,
          before: { displayName: existing.displayName, branchIds: existing.branchIds },
          after: {
            displayName: changes.displayName ?? existing.displayName,
            branchIds: changes.branchIds ?? existing.branchIds,
          },
        }, at));
      }
      await audit(records);
    });

    const user = await repo.findUser(hospitalId, id);
    return reply.status(200).send({ user: user && describeUserSummary(user) });
  });

  app.post(`${V1}/users/:id/reset-password`, guarded("admin.users"), async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return refuse(reply, 400, "That identifier is not valid.");
    const hospitalId = tenantOf(request);
    const existing = await repo.findUser(hospitalId, id);
    if (existing === null) return refuse(reply, 404, "No such account.");
    if (existing.providerId !== "local") {
      return refuse(reply, 409, "This account signs in through a directory; reset its password there.");
    }

    const password = generatePassword();
    const hashed = await hashPassword(password);
    const at = deps.now();
    await write(async (tx, audit) => {
      await repo.setPassword(tx, hospitalId, id, hashed.hash, hashed.salt, true, at);
      await repo.clearLockout(tx, hospitalId, existing.username);
      // Whoever was signed in with the old password is not any more.
      await repo.endSessionsForUser(tx, hospitalId, id, "password_changed", at);
      await audit([
        auditRecord(request, "admin.password_reset", `Password reset for ${existing.username}`, { userId: id }, at),
      ]);
    });
    deps.logger.info("password reset", { requestId: request.requestId, hospitalId, userId: id });
    return reply.status(200).send({ temporaryPassword: password });
  });

  app.post(`${V1}/users/:id/unlock`, guarded("admin.users"), async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return refuse(reply, 400, "That identifier is not valid.");
    const hospitalId = tenantOf(request);
    const existing = await repo.findUser(hospitalId, id);
    if (existing === null) return refuse(reply, 404, "No such account.");
    const at = deps.now();
    await write(async (tx, audit) => {
      await repo.clearLockout(tx, hospitalId, existing.username);
      await audit([
        auditRecord(request, "admin.account_unlocked", `Account ${existing.username} unlocked`, { userId: id }, at),
      ]);
    });
    return reply.status(204).send();
  });

  /**
   * Changes the caller's own password.
   *
   * Signed in rather than permissioned: it is the one thing an account with a
   * temporary password is allowed to do. The current password is required even
   * then, so a session left open on a shared workstation cannot be used to take
   * the account over. Every other session of the account is ended.
   */
  app.post(`${V1}/auth/password`, { preHandler: requireSignedIn(deps.guards) }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const current = typeof body["currentPassword"] === "string" ? body["currentPassword"] : "";
    const next = typeof body["newPassword"] === "string" ? body["newPassword"] : "";
    const caller = request.authenticated!;
    const hospitalId = tenantOf(request);

    const stored = await deps.accounts.findById(caller.user.account.id);
    if (stored === null || stored.passwordHash === null || stored.passwordSalt === null) {
      return refuse(reply, 409, "This account's password is managed elsewhere.");
    }
    if (!(await verifyPassword(current, stored.passwordHash, stored.passwordSalt))) {
      return refuse(reply, 403, "Your current password is not correct.", { reason: "invalid_credentials" });
    }
    if (next === current) return refuse(reply, 422, "Choose a password different from the current one.");
    const check = checkPassword(next, { username: caller.user.account.username });
    if (!check.ok) return refuse(reply, 422, "That password is not strong enough.", { problems: check.problems });

    const hashed = await hashPassword(next);
    const at = deps.now();
    const ended = await write(async (tx, audit) => {
      await repo.setPassword(tx, hospitalId, caller.user.account.id, hashed.hash, hashed.salt, false, at);
      const count = await repo.endSessionsForUser(
        tx,
        hospitalId,
        caller.user.account.id,
        "password_changed",
        at,
        caller.session.id,
      );
      await audit([
        auditRecord(request, "auth.password_changed", `${caller.user.account.username} changed their password`, {
          userId: caller.user.account.id,
          otherSessionsEnded: count,
        }, at),
      ]);
      return count;
    });
    return reply.status(200).send({ otherSessionsEnded: ended });
  });

  // ──────────────────────────────────────────────────────────── sessions

  app.get(`${V1}/sessions`, guarded("admin.users"), async (request, reply) => {
    const sessions = await repo.listSessions(tenantOf(request));
    const own = request.authenticated!.session.id;
    return reply.status(200).send({
      sessions: sessions.map((session) => ({
        id: session.id,
        userId: session.userId,
        displayName: session.displayName,
        username: session.username,
        branchId: session.branchId,
        device: session.device,
        startedAt: session.startedAt.toISOString(),
        lastActiveAt: session.lastActiveAt.toISOString(),
        current: session.id === own,
      })),
    });
  });

  app.post(`${V1}/sessions/:id/revoke`, guarded("admin.users"), async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return refuse(reply, 400, "That identifier is not valid.");
    const hospitalId = tenantOf(request);
    const at = deps.now();
    const holder = await write(async (tx, audit) => {
      const userId = await repo.endSession(tx, hospitalId, id, "terminated_by_admin", at);
      if (userId === null) return null;
      await audit([
        auditRecord(request, "auth.session_terminated", "A session was ended by an administrator", {
          sessionId: id,
          userId,
        }, at),
      ]);
      return userId;
    });
    if (holder === null) return refuse(reply, 404, "No such session.");
    return reply.status(204).send();
  });

  // ──────────────────────────────────────────────────────────── branches

  app.get(`${V1}/branches`, { preHandler: requireSignedIn(deps.guards) }, async (request, reply) => {
    const branches = await repo.listBranches(tenantOf(request));
    return reply.status(200).send({ branches });
  });

  app.post(`${V1}/branches`, guarded("admin.settings"), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const hospitalId = tenantOf(request);
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    const code = typeof body["code"] === "string" ? body["code"].trim() : "";
    if (name === "" || name.length > 120) return refuse(reply, 422, "A branch needs a name, up to 120 characters.");
    if (!BRANCH_CODE.test(code)) return refuse(reply, 422, "A branch code is up to 16 letters, digits or dashes.");
    if (await repo.isBranchCodeTaken(hospitalId, code)) return refuse(reply, 409, "That branch code is already in use.");

    const at = deps.now();
    const id = await write(async (tx, audit) => {
      const created = await repo.createBranch(tx, hospitalId, { name, code }, at);
      await audit([auditRecord(request, "config.branch_created", `Branch ${name} created`, { branchId: created, name, code }, at)]);
      return created;
    });
    return reply.status(201).send({ branch: { id, name, code, isDefault: false } });
  });

  app.patch(`${V1}/branches/:id`, guarded("admin.settings"), async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return refuse(reply, 400, "That identifier is not valid.");
    const body = (request.body ?? {}) as Record<string, unknown>;
    const hospitalId = tenantOf(request);

    const changes: { name?: string; code?: string; isDefault?: boolean } = {};
    if ("name" in body) {
      const name = typeof body["name"] === "string" ? body["name"].trim() : "";
      if (name === "" || name.length > 120) return refuse(reply, 422, "A branch needs a name, up to 120 characters.");
      changes.name = name;
    }
    if ("code" in body) {
      const code = typeof body["code"] === "string" ? body["code"].trim() : "";
      if (!BRANCH_CODE.test(code)) return refuse(reply, 422, "A branch code is up to 16 letters, digits or dashes.");
      if (await repo.isBranchCodeTaken(hospitalId, code, id)) return refuse(reply, 409, "That branch code is already in use.");
      changes.code = code;
    }
    if ("isDefault" in body) {
      if (body["isDefault"] !== true) return refuse(reply, 422, "A branch is made the default by setting isDefault to true.");
      changes.isDefault = true;
    }
    if (Object.keys(changes).length === 0) return refuse(reply, 400, "Nothing to change.");

    const at = deps.now();
    const found = await write(async (tx, audit) => {
      const updated = await repo.updateBranch(tx, hospitalId, id, changes);
      if (!updated) return false;
      await audit([auditRecord(request, "config.branch_updated", "Branch updated", { branchId: id, ...changes }, at)]);
      return true;
    });
    if (!found) return refuse(reply, 404, "No such branch.");
    const branch = (await repo.listBranches(hospitalId)).find((b) => b.id === id);
    return reply.status(200).send({ branch });
  });
}
