import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLES,
  PERMISSIONS,
  PERMISSION_GROUPS,
  can,
  validateRoles,
} from "./rbac.js";

describe("permissions catalogue", () => {
  it("groups every permission exactly once for the admin UI", () => {
    const grouped = PERMISSION_GROUPS.flatMap((group) => group.permissions);
    expect([...grouped].sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("gives every permission a human-readable description", () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(PERMISSIONS[permission].length).toBeGreaterThan(0);
    }
  });
});

describe("default roles", () => {
  it("gives the administrator everything", () => {
    const admin = DEFAULT_ROLES.find((r) => r.id === "role-administrator")!;
    for (const permission of ALL_PERMISSIONS) {
      expect(can(admin, permission)).toBe(true);
    }
  });

  /**
   * The manager dashboard is built to work from tickets alone, so the manager
   * role does not get identity access by default. A permission granted by
   * default is a permission nobody ever reviews.
   */
  it("does not give managers access to patient identities by default", () => {
    const manager = DEFAULT_ROLES.find((r) => r.id === "role-manager")!;
    expect(can(manager, "visit.view_identity")).toBe(false);
    expect(can(manager, "reports.view")).toBe(true);
  });

  it("does not let clinicians administer the platform", () => {
    const clinician = DEFAULT_ROLES.find((r) => r.id === "role-clinician")!;
    expect(can(clinician, "admin.users")).toBe(false);
    expect(can(clinician, "admin.stations")).toBe(false);
    expect(can(clinician, "queue.call")).toBe(true);
  });

  it("marks built-in roles as undeletable", () => {
    expect(DEFAULT_ROLES.every((role) => role.isSystem)).toBe(true);
  });

  it("is itself a valid configuration", () => {
    expect(validateRoles(DEFAULT_ROLES)).toEqual([]);
  });
});

describe("role validation", () => {
  /**
   * The one mistake that cannot be undone from inside the product: removing the
   * last role that can manage users locks the hospital out of its own platform.
   */
  it("refuses to leave nobody able to manage users", () => {
    const crippled = DEFAULT_ROLES.map((role) => ({
      ...role,
      permissions: role.permissions.filter((p) => p !== "admin.users"),
    }));
    expect(validateRoles(crippled).join(" ")).toMatch(/Manage users and roles/);
  });

  it("rejects duplicate and empty role names", () => {
    const problems = validateRoles([
      { ...DEFAULT_ROLES[3]!, id: "a", name: "Admin" },
      { ...DEFAULT_ROLES[3]!, id: "b", name: "admin" },
      { ...DEFAULT_ROLES[3]!, id: "c", name: "  " },
    ]);
    expect(problems.some((p) => /both called/.test(p))).toBe(true);
    expect(problems.some((p) => /needs a name/.test(p))).toBe(true);
  });

  it("refuses a permission that is not in the catalogue", () => {
    const problems = validateRoles([
      ...DEFAULT_ROLES,
      { ...DEFAULT_ROLES[0]!, id: "x", name: "Typo", permissions: ["queue.cal" as never] },
    ]);
    expect(problems.some((p) => /queue\.cal, which is not a QMan permission/.test(p))).toBe(true);
  });

  it("refuses a permission list that is not a list of names", () => {
    const problems = validateRoles([
      ...DEFAULT_ROLES,
      { ...DEFAULT_ROLES[0]!, id: "y", name: "Odd", permissions: [42 as never] },
      { ...DEFAULT_ROLES[0]!, id: "z", name: "Odder", permissions: "queue.call" as never },
    ]);
    expect(problems.some((p) => /not a name/.test(p))).toBe(true);
    expect(problems.some((p) => /must list its permissions/.test(p))).toBe(true);
  });
});
