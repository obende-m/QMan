/**
 * Platform permissions.
 *
 * QMan's own administration, which is a different thing from a hospital's. A
 * platform administrator creates and suspends organizations; a hospital's
 * administrator configures stations and staff. Neither can do the other's job,
 * and this file is half of why.
 *
 * **This catalogue is deliberately not part of `PERMISSIONS`.**
 *
 * A hospital's roles store their grants as `text[]`, validated against the
 * organization catalogue. If platform capabilities were added to that set, an
 * organization administrator holding `admin.users` could create a role granting
 * `platform.organizations.create` and assign it to themselves — escalating out
 * of their own tenant using nothing but the feature they are supposed to have.
 *
 * Two catalogues with no shared type make that unrepresentable rather than
 * forbidden. `isPlatformPermission` is the boundary check, and role validation
 * uses it to refuse a grant that names one of these even if a request arrives
 * with one hand-written into the array.
 */

export const PLATFORM_PERMISSIONS = {
  "platform.organizations.view": "View organizations",
  "platform.organizations.create": "Create an organization",
  "platform.organizations.suspend": "Suspend and reactivate an organization",
  "platform.organizations.reset_admin": "Reset an organization's administrator",
  "platform.audit.view": "View the platform audit log",
  "platform.health.view": "View platform health",
} as const;

export type PlatformPermission = keyof typeof PLATFORM_PERMISSIONS;

export const ALL_PLATFORM_PERMISSIONS = Object.keys(
  PLATFORM_PERMISSIONS,
) as PlatformPermission[];

/**
 * The prefix is the boundary.
 *
 * Checked as a prefix rather than by membership of the catalogue above, so that
 * a permission invented in a later release is refused by this release's role
 * validation rather than accepted as an unrecognised string.
 */
export const PLATFORM_PERMISSION_PREFIX = "platform.";

export function isPlatformPermission(value: string): boolean {
  return value.startsWith(PLATFORM_PERMISSION_PREFIX);
}

/**
 * Platform roles.
 *
 * One in V1. It exists as a named set rather than an implicit "can do
 * everything" so that a read-only support role is later a row, not a release.
 */
export const PLATFORM_ROLES = {
  super_admin: ALL_PLATFORM_PERMISSIONS,
} as const;

export type PlatformRole = keyof typeof PLATFORM_ROLES;

export const ALL_PLATFORM_ROLES = Object.keys(PLATFORM_ROLES) as PlatformRole[];

export function isPlatformRole(value: string): value is PlatformRole {
  return Object.prototype.hasOwnProperty.call(PLATFORM_ROLES, value);
}

export function permissionsForPlatformRole(role: PlatformRole): readonly PlatformPermission[] {
  return PLATFORM_ROLES[role];
}
