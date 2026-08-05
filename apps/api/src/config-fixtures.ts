/**
 * Shared test doubles for the configuration suites.
 *
 * Not a suite itself. Extracted so the write tests and the lifecycle tests
 * exercise the same fakes: two copies of a fake database drift, and the second
 * copy is always the one that stops matching how the real loader reads.
 */
import {
  DEFAULT_TICKET_TEMPLATE,
  UserId,
  type HospitalConfiguration,
  type RoleConfig,
  type Session,
  type StationConfig,
} from "@qman/domain";
import {
  FakeDatabase,
  type AccountRepository,
  type ConfigurationRepository,
  type ConfigurationWriter,
  type EntityUsage,
  type SessionRepository,
  type SqlExecutor,
  type StoredAccount,
} from "@qman/persistence";
import { hashPassword } from "./passwords.js";

export const ORIGIN = "https://qman.hospital.example";
export const HOSPITAL = "11111111-1111-1111-1111-111111111111";
export const BRANCH = "22222222-2222-2222-2222-222222222222";
export const STATION = "44444444-4444-4444-4444-444444444444";
export const WORKFLOW = "66666666-6666-6666-6666-666666666666";
export const PASSWORD = "a reasonable passphrase";

/** Cheap parameters: these suites test orchestration, not hashing cost. */
export const FAST = { N: 1024, r: 8, p: 1, keyLength: 64 };

export function stationConfig(overrides: Partial<StationConfig> = {}): StationConfig {
  return {
    id: STATION,
    name: "Consultation",
    code: "CONS",
    room: "Room 12",
    staffing: 2,
    serviceEstimateMillis: 600_000,
    sla: { targetWaitMillis: 1_200_000, saturationPoint: 20 },
    queueNumber: { template: "A-{n:3}", reset: "daily" },
    isPublic: true,
    enabled: true,
    ...overrides,
  } as StationConfig;
}

/**
 * A configuration the domain considers admissible.
 *
 * It needs a workflow and a ticket template, because without them a patient
 * cannot be admitted at all — and a fixture that fails validation makes every
 * test about validation rather than about the change under test.
 */
export function configuration(): HospitalConfiguration {
  return {
    profile: {
      id: HOSPITAL,
      name: "Ikeja General Hospital",
      code: "IKJ",
      timezone: "Africa/Lagos",
      supportPhone: null,
      brandColor: "#003ec7",
    },
    branches: [{ id: BRANCH, name: "Main", code: "MAIN", isDefault: true }],
    stations: [stationConfig()],
    workflows: [
      {
        id: WORKFLOW,
        branchId: BRANCH,
        name: "Standard visit",
        isDefault: true,
        stages: [
          {
            id: "stage-1",
            stationId: STATION,
            sequence: 1,
            isRequired: true,
            allowSkip: false,
            allowRepeat: false,
            branchesTo: [],
          },
        ],
      },
    ],
    displayBoards: [],
    ticketTemplates: [DEFAULT_TICKET_TEMPLATE],
    defaults: { namePolicy: "ticket_only", ticketTemplateId: DEFAULT_TICKET_TEMPLATE.id },
  } as unknown as HospitalConfiguration;
}

/**
 * Queues the rows the configuration loader reads, in the order it reads them.
 *
 * Deliberately not a stubbed repository: the service builds its own against the
 * transaction, and going through the real loader keeps these tests honest about
 * the shape the database actually returns.
 */
export function primeConfigurationRead(
  db: FakeDatabase,
  config: HospitalConfiguration,
): void {
  db.willReturn([
    {
      id: HOSPITAL,
      name: config.profile.name,
      code: config.profile.code,
      timezone: config.profile.timezone,
      support_phone: config.profile.supportPhone,
      brand_color: config.profile.brandColor,
    },
  ])
    .willReturn(
      config.branches.map((b) => ({
        id: b.id,
        name: b.name,
        code: b.code,
        is_default: b.isDefault,
      })),
    )
    .willReturn(
      config.stations.map((s) => ({
        id: s.id,
        branch_id: BRANCH,
        name: s.name,
        code: s.code,
        room: s.room,
        staffing: s.staffing,
        service_estimate_ms: s.serviceEstimateMillis,
        sla_target_wait_ms: s.sla.targetWaitMillis,
        sla_saturation_point: s.sla.saturationPoint,
        queue_template: s.queueNumber.template,
        queue_reset: s.queueNumber.reset,
        queue_manual_epoch: null,
        is_public: s.isPublic,
        enabled: s.enabled,
      })),
    )
    .willReturn(
      config.workflows.map((w) => ({
        id: w.id,
        branch_id: BRANCH,
        name: w.name,
        is_default: w.isDefault,
      })),
    )
    .willReturn(
      config.workflows.flatMap((w) =>
        w.stages.map((stage) => ({
          id: stage.id,
          workflow_id: w.id,
          station_id: stage.stationId,
          sequence: stage.sequence,
          is_required: stage.isRequired,
          allow_skip: stage.allowSkip,
          allow_repeat: stage.allowRepeat,
          branches_to: [...stage.branchesTo],
        })),
      ),
    )
    .willReturn(
      config.displayBoards.map((b) => ({
        id: b.id,
        branch_id: BRANCH,
        name: b.name,
        station_ids: [...b.stationIds],
        waiting_to_show: b.waitingToShow,
        name_policy: b.namePolicy,
        show_estimated_wait: b.showEstimatedWait,
        show_room: b.showRoom,
      })),
    )
    .willReturn(
      config.ticketTemplates.map((t) => ({
        id: t.id,
        name: t.name,
        paper: t.paper,
        elements: t.elements,
        instructions: t.instructions,
        footer: t.footer,
        name_policy: t.namePolicy,
        tracking_url: t.trackingUrl,
      })),
    )
    .willReturn([{ settings: config.defaults }]);
}

export function primeRolesRead(db: FakeDatabase, roles: readonly RoleConfig[]): void {
  db.willReturn(
    roles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      permissions: [...role.permissions],
      is_system: role.isSystem,
    })),
  );
}

export class RecordingWriter implements ConfigurationWriter {
  readonly stations: StationConfig[] = [];
  readonly others: string[] = [];
  readonly created: string[] = [];
  readonly deleted: string[] = [];
  readonly roles: RoleConfig[] = [];
  /** What the usage checks report, so a deletion can be blocked on demand. */
  usage: EntityUsage[] = [];

  async stationUsage(): Promise<EntityUsage[]> {
    return this.usage;
  }
  async workflowUsage(): Promise<EntityUsage[]> {
    return this.usage;
  }
  async roleUsage(): Promise<EntityUsage[]> {
    return this.usage;
  }

  async createStation(_tx: SqlExecutor, _branch: string, s: StationConfig): Promise<void> {
    this.created.push("station");
    this.stations.push(s);
  }
  async createWorkflow(): Promise<void> {
    this.created.push("workflow");
  }
  async createBoard(): Promise<void> {
    this.created.push("board");
  }
  async createTicketTemplate(): Promise<void> {
    this.created.push("template");
  }
  async createRole(_tx: SqlExecutor, _hospital: string, role: RoleConfig): Promise<void> {
    this.created.push("role");
    this.roles.push(role);
  }

  async deleteStation(): Promise<void> {
    this.deleted.push("station");
  }
  async deleteWorkflow(): Promise<void> {
    this.deleted.push("workflow");
  }
  async deleteBoard(): Promise<void> {
    this.deleted.push("board");
  }
  async deleteTicketTemplate(): Promise<void> {
    this.deleted.push("template");
  }
  async deleteRole(): Promise<void> {
    this.deleted.push("role");
  }

  async updateStation(_tx: SqlExecutor, s: StationConfig): Promise<void> {
    this.stations.push(s);
  }
  async updateWorkflow(): Promise<void> {
    this.others.push("workflow");
  }
  async updateBoard(): Promise<void> {
    this.others.push("board");
  }
  async updateTicketTemplate(): Promise<void> {
    this.others.push("template");
  }
  async updateRole(_tx: SqlExecutor, _hospital: string, role: RoleConfig): Promise<void> {
    this.others.push("role");
    this.roles.push(role);
  }
  async updateProfile(): Promise<void> {
    this.others.push("profile");
  }
  async updateDefaults(): Promise<void> {
    this.others.push("defaults");
  }
}

export class FakeConfiguration implements ConfigurationRepository {
  async load(): Promise<HospitalConfiguration | null> {
    return configuration();
  }
  async loadRoles(): Promise<RoleConfig[]> {
    return [];
  }
}

export class FakeAccounts implements AccountRepository {
  readonly accounts: StoredAccount[] = [];

  async findByUsername(hospitalId: string, username: string): Promise<StoredAccount | null> {
    return (
      this.accounts.find(
        (a) =>
          a.hospitalId === hospitalId &&
          a.account.username.toLowerCase() === username.toLowerCase(),
      ) ?? null
    );
  }
  async findById(userId: string): Promise<StoredAccount | null> {
    return this.accounts.find((a) => a.account.id === userId) ?? null;
  }
  async updatePassword(): Promise<void> {}
}

export class FakeSessions implements SessionRepository {
  readonly rows = new Map<string, { session: Session; tokenHash: string }>();

  async find(id: string): Promise<Session | null> {
    return this.rows.get(id)?.session ?? null;
  }
  async findByToken(tokenHash: string): Promise<Session | null> {
    for (const row of this.rows.values()) {
      if (row.tokenHash === tokenHash && row.session.endedAt === null) return row.session;
    }
    return null;
  }
  async create(session: Session, tokenHash: string): Promise<void> {
    this.rows.set(session.id, { session, tokenHash });
  }
  async activeForHospital(): Promise<Session[]> {
    return [];
  }
  async save(session: Session): Promise<void> {
    const existing = this.rows.get(session.id);
    if (existing) this.rows.set(session.id, { ...existing, session });
  }
  async endAllForUser(): Promise<number> {
    return 0;
  }
}

export async function account(permissions: string[]): Promise<StoredAccount> {
  const stored = await hashPassword(PASSWORD, FAST);
  return {
    account: {
      id: UserId("aaaaaaaa-0000-0000-0000-000000000001"),
      displayName: "Adaeze Okonkwo",
      username: "adaeze",
      roleId: "r1",
      branchIds: [],
      providerId: "local",
      enabled: true,
    },
    hospitalId: HOSPITAL,
    roleKey: "admin",
    permissions,
    passwordHash: stored.hash,
    passwordSalt: stored.salt,
  } as StoredAccount;
}

/** The cookies and CSRF token a signed-in administrator carries. */
export function credentialsFrom(setCookie: string | string[] | undefined): {
  cookie: string;
  csrf: string;
} {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  return {
    cookie: values.map((c) => c.split(";")[0]).join("; "),
    csrf: decodeURIComponent(
      values.find((c) => c.startsWith("qman_csrf"))!.split(";")[0]!.split("=")[1]!,
    ),
  };
}
