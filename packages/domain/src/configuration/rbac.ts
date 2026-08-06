/**
 * Roles and permissions.
 *
 * The permission catalogue is a closed set defined here, not free-form strings.
 * A typo in a permission name must be a compile error, because the failure mode
 * of a mistyped permission is a check that silently never passes — or worse,
 * a guard that is never applied at all.
 *
 * Roles, by contrast, are data: a hospital invents "Senior Triage Nurse" without
 * a release, and assigns it whichever permissions it likes — from this
 * catalogue only. Platform administration has its own, and `validateRoles`
 * refuses any grant that reaches across.
 */
import { isPlatformPermission } from "../platform/permissions.js";

export const PERMISSIONS = {
  "visit.create": "Create a visit",
  "visit.cancel": "Cancel a visit",
  "visit.view_identity": "See patient names and hospital numbers",
  "queue.call": "Call the next patient",
  "queue.recall": "Recall a patient",
  "queue.skip": "Skip a patient",
  "queue.start": "Start service",
  "queue.complete": "Complete a stage",
  "queue.route": "Route a visit to another station",
  "queue.route_off_workflow": "Route outside the workflow",
  "visit.escalate": "Change a visit's priority",
  "reports.view": "View dashboards and reports",
  "reports.export": "Export reports",
  "admin.stations": "Configure stations and queue numbering",
  "admin.workflows": "Configure workflows",
  "admin.display_boards": "Configure display boards",
  "admin.users": "Manage users and roles",
  "admin.settings": "Change hospital settings and privacy policy",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** Grouping for the administration UI, so the list is navigable. */
export const PERMISSION_GROUPS: ReadonlyArray<{
  readonly name: string;
  readonly permissions: readonly Permission[];
}> = [
  {
    name: "Visits",
    permissions: ["visit.create", "visit.cancel", "visit.escalate", "visit.view_identity"],
  },
  {
    name: "Queue",
    permissions: [
      "queue.call",
      "queue.recall",
      "queue.skip",
      "queue.start",
      "queue.complete",
      "queue.route",
      "queue.route_off_workflow",
    ],
  },
  { name: "Reporting", permissions: ["reports.view", "reports.export"] },
  {
    name: "Administration",
    permissions: [
      "admin.stations",
      "admin.workflows",
      "admin.display_boards",
      "admin.users",
      "admin.settings",
    ],
  },
];

export interface RoleConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly Permission[];
  /**
   * Built-in roles ship with QMan and cannot be deleted, only copied. Without
   * this a hospital can delete every administrative role and lock itself out.
   */
  readonly isSystem: boolean;
}

export const DEFAULT_ROLES: readonly RoleConfig[] = [
  {
    id: "role-receptionist",
    name: "Receptionist",
    description: "Registers arrivals and starts journeys.",
    permissions: [
      "visit.create",
      "visit.cancel",
      "visit.view_identity",
      "queue.call",
      "queue.recall",
      "queue.skip",
      "queue.start",
      "queue.complete",
      "queue.route",
      "visit.escalate",
    ],
    isSystem: true,
  },
  {
    id: "role-clinician",
    name: "Clinician",
    description: "Doctors, nurses and allied staff working a station.",
    permissions: [
      "visit.view_identity",
      "queue.call",
      "queue.recall",
      "queue.skip",
      "queue.start",
      "queue.complete",
      "queue.route",
      "queue.route_off_workflow",
      "visit.escalate",
      "reports.view",
    ],
    isSystem: true,
  },
  {
    id: "role-manager",
    name: "Manager",
    description:
      "Oversees flow across stations. Sees operational data, not identities.",
    // Deliberately without visit.view_identity: the manager dashboard is
    // designed to work from tickets, and a permission granted by default is a
    // permission nobody ever reviews.
    permissions: ["reports.view", "reports.export", "admin.display_boards"],
    isSystem: true,
  },
  {
    id: "role-administrator",
    name: "Administrator",
    description: "Configures the platform for this hospital.",
    permissions: ALL_PERMISSIONS,
    isSystem: true,
  },
];

export function can(role: RoleConfig, permission: Permission): boolean {
  return role.permissions.includes(permission);
}

/**
 * Validates a set of roles.
 *
 * The check that matters: at least one role must retain `admin.users`, or the
 * hospital locks itself out of its own administration with no way back that
 * does not involve a support engineer and a database.
 */
export function validateRoles(roles: readonly RoleConfig[]): string[] {
  const problems: string[] = [];

  /*
   * A hospital's role may never carry a platform permission.
   *
   * The type says it cannot, and over the wire the type is a suggestion: role
   * writes arrive as JSON and `permissions` is whatever array was sent. Without
   * this check an organization administrator holding `admin.users` could grant
   * themselves `platform.organizations.create` by hand and leave their own
   * tenant — using nothing but the feature they are meant to have.
   *
   * Checked by prefix, so a platform permission added in a later release is
   * refused by this one rather than accepted as an unrecognised string.
   */
  for (const role of roles) {
    for (const permission of role.permissions) {
      if (isPlatformPermission(permission)) {
        problems.push(
          `“${role.name}” asks for ${permission}, which belongs to QMan platform administration and cannot be granted by a hospital.`,
        );
      }
    }
  }

  if (!roles.some((role) => can(role, "admin.users"))) {
    problems.push(
      "At least one role must keep “Manage users and roles”, otherwise nobody can administer the hospital.",
    );
  }

  const names = new Set<string>();
  for (const role of roles) {
    const name = role.name.trim().toLowerCase();
    if (name.length === 0) {
      problems.push("Every role needs a name.");
    } else if (names.has(name)) {
      problems.push(`Two roles are both called “${role.name}”.`);
    }
    names.add(name);
  }

  return problems;
}
