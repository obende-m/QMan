/**
 * Creating an organization.
 *
 * The only path by which a hospital comes into existence, and it runs in one
 * transaction: the hospital, its default branch, the roles it starts with, and
 * one administrator who can sign in. A partial organization — a hospital row
 * with no branch, or a branch with no administrator — is not a state anybody
 * can recover from through the product, so it is not a state this can leave
 * behind.
 *
 * Nothing here re-decides what a hospital starts with. The roles are the
 * domain's `DEFAULT_ROLES`, written through the same `ConfigurationWriter` the
 * configuration API uses, and the password is hashed by the same `passwords.ts`
 * every other account uses. An organization created here is indistinguishable
 * from one built up through the configuration screens, which is the point.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_TICKET_TEMPLATE,
  DEFAULT_ROLES,
  StationId,
  BranchId,
  WorkflowId,
  WorkflowStageId,
  type RoleConfig,
  type StationConfig,
  type Workflow,
} from "@qman/domain";
import type { ConfigurationWriter, Database } from "@qman/persistence";
import { hashPassword } from "./passwords.js";
import type { OrganizationProvisioning } from "./platform-routes.js";
import { generatePassword } from "./tokens.js";

/**
 * The role a new organization's administrator is given.
 *
 * Found by key rather than by position, so reordering `DEFAULT_ROLES` cannot
 * quietly hand a new hospital's administrator the receptionist's permissions.
 */
function administratorRole(): RoleConfig {
  const role = DEFAULT_ROLES.find((candidate) => candidate.id === "role-administrator");
  if (role === undefined) {
    throw new Error("DEFAULT_ROLES no longer contains role-administrator.");
  }
  return role;
}

export class PostgresOrganizationProvisioning implements OrganizationProvisioning {
  constructor(
    private readonly db: Database,
    private readonly writer: ConfigurationWriter,
  ) {}

  async create(input: {
    readonly code: string;
    readonly name: string;
    readonly timezone: string;
    readonly branchName: string;
    readonly adminUsername: string;
    readonly adminDisplayName: string;
    readonly at: Date;
  }): Promise<{ organizationId: string; adminPassword: string }> {
    const password = generatePassword();
    const hashed = await hashPassword(password);

    const organizationId = await this.db.transaction(async (tx) => {
      const [hospitalRow] = await tx.query<{ id: string }>(
        `INSERT INTO hospitals (name, code, timezone, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', $4, $4)
         RETURNING id`,
        [input.name, input.code, input.timezone, input.at],
      );
      const hospitalId = hospitalRow!.id;

      const [branchRow] = await tx.query<{ id: string }>(
        `INSERT INTO branches (hospital_id, name, code, is_default, created_at)
         VALUES ($1, $2, 'main', true, $3)
         RETURNING id`,
        [hospitalId, input.branchName, input.at],
      );
      const branchId = branchRow!.id;

      /*
       * Fresh ids per organization.
       *
       * `DEFAULT_ROLES` carries stable ids like "role-administrator" because it
       * is a template. Writing those verbatim would make the second
       * organization collide with the first on the roles primary key.
       */
      const adminTemplate = administratorRole();
      let adminRoleId = "";
      for (const role of DEFAULT_ROLES) {
        const id = randomUUID();
        if (role.id === adminTemplate.id) adminRoleId = id;
        await this.writer.createRole(tx, hospitalId, { ...role, id }, input.at);
      }

      /*
       * A starter configuration, because an empty one is not a valid one.
       *
       * `validateHospitalConfiguration` requires at least one ticket template
       * and at least one workflow, and a workflow requires a stage, and a stage
       * requires a station. Configuration writes validate the whole document,
       * so an organization created without these cannot be configured at all:
       * the administrator's first attempt to add a station is refused for the
       * workflow and template that were never there. That is a deadlock with no
       * way out through the product.
       *
       * So provisioning creates the smallest configuration that is valid and
       * useful — one Reception station, one workflow through it, and the
       * domain's default ticket template. Everything here is ordinary
       * configuration the administrator can rename, extend or replace.
       */
      const stationId = StationId(randomUUID());
      const reception: StationConfig = {
        id: stationId,
        name: "Reception",
        code: "REC",
        room: null,
        staffing: 1,
        serviceEstimateMillis: 600_000,
        sla: { targetWaitMillis: 1_800_000, saturationPoint: 20 },
        queueNumber: { template: "{n:3}", reset: "daily" },
        isPublic: true,
        enabled: true,
      };
      await this.writer.createStation(tx, branchId, reception, input.at);

      const workflow: Workflow = {
        id: WorkflowId(randomUUID()),
        branchId: BranchId(branchId),
        name: "General",
        isDefault: true,
        stages: [
          {
            id: WorkflowStageId(randomUUID()),
            stationId,
            sequence: 1,
            isRequired: true,
            allowSkip: false,
            allowRepeat: false,
            branchesTo: [],
          },
        ],
      };
      await this.writer.createWorkflow(tx, branchId, workflow, input.at);

      // A fresh id, for the reason the roles get one: DEFAULT_TICKET_TEMPLATE
      // is a template carrying the stable id "ticket-default", which is not a
      // uuid and could not be shared between organizations even if it were.
      const ticketTemplateId = randomUUID();
      await this.writer.createTicketTemplate(
        tx,
        hospitalId,
        { ...DEFAULT_TICKET_TEMPLATE, id: ticketTemplateId },
        input.at,
      );

      // The hospital's own settings row, naming the template tickets print
      // from. Without it `configuration.load` has no defaults to return and the
      // organization reads as unconfigured.
      await this.writer.updateDefaults(
        tx,
        hospitalId,
        { namePolicy: "ticket_only", ticketTemplateId },
        input.at,
      );

      await tx.query(
        `INSERT INTO users
           (hospital_id, role_id, display_name, username, provider_id,
            password_hash, password_salt, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'local', $5, $6, true, $7, $7)`,
        [
          hospitalId,
          adminRoleId,
          input.adminDisplayName,
          input.adminUsername,
          hashed.hash,
          hashed.salt,
          input.at,
        ],
      );

      return hospitalId;
    });

    return { organizationId, adminPassword: password };
  }

  /**
   * Resets an administrator's password, and ends their sessions.
   *
   * Ending the sessions is not tidiness. This is the path used when a hospital
   * has lost control of an account, and a reset that left the existing sessions
   * alive would change the password while whoever was already signed in stayed
   * signed in.
   *
   * Scoped by hospital on both statements. The username is unique per hospital,
   * not globally, so a query without that scope would find a different
   * hospital's administrator with the same name — which is the precise mistake
   * §6.2's guard exists to catch, and which is better not made here.
   */
  async resetAdministrator(input: {
    readonly organizationId: string;
    readonly username: string;
    readonly at: Date;
  }): Promise<{ username: string; password: string } | null> {
    const [user] = await this.db.query<{ id: string; username: string }>(
      `SELECT id, username FROM users
       WHERE hospital_id = $1 AND lower(username) = lower($2)`,
      [input.organizationId, input.username],
    );
    if (user === undefined) return null;

    const password = generatePassword();
    const hashed = await hashPassword(password);

    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE users SET password_hash = $2, password_salt = $3, updated_at = $4
         WHERE id = $1`,
        [user.id, hashed.hash, hashed.salt, input.at],
      );
      await tx.query(
        `UPDATE sessions SET ended_at = $2, end_reason = 'password_reset'
         WHERE user_id = $1 AND ended_at IS NULL`,
        [user.id, input.at],
      );
    });

    return { username: user.username, password };
  }
}
