/**
 * An organization, as the platform sees it.
 *
 * A hospital viewed from the outside: its identity, its lifecycle, and nothing
 * about its stations or staff. The configuration domain already models what a
 * hospital *is*; this models the fact that QMan hosts it.
 *
 * **Identity is the id, and only the id.**
 *
 * Three fields could plausibly name an organization and only one may. `id` is an
 * immutable UUID and is the tenant identifier everywhere: every foreign key,
 * every scope check, every audit record. `code` is what staff type at sign-in,
 * and `name` is what people read. Both are editable, because neither is
 * identity — changing a code changes what is typed into a login form and
 * nothing else, since nothing joins on it.
 *
 * The rule exists because the failure it prevents is silent. A system that keys
 * on the code works perfectly until the first rename, at which point rows
 * scoped to the old value are neither found nor deleted — they are simply
 * invisible, which for tenant-scoped data means one hospital's records quietly
 * detached from it.
 */

/**
 * Suspension is reversible and destroys nothing.
 *
 * A suspended organization keeps every row it had. Its staff cannot sign in and
 * its boards stop serving, which is what makes suspension meaningful to a
 * hospital, but reactivation is a status change rather than a restore.
 */
export type OrganizationStatus = "active" | "suspended";

export interface Organization {
  /** Immutable. The tenant identifier, everywhere, forever. */
  readonly id: string;
  /** Globally unique. The login selector, and editable. */
  readonly code: string;
  /** Editable, and never an identifier. */
  readonly name: string;
  readonly status: OrganizationStatus;
  readonly timezone: string;
  readonly suspendedAt: Date | null;
  readonly suspendedReason: string | null;
  readonly createdAt: Date;
}

export function isActive(organization: Organization): boolean {
  return organization.status === "active";
}

/**
 * The shape of an organization code.
 *
 * Typed by a receptionist at the start of a shift, on a keyboard, often from a
 * card. Lowercase letters, digits and hyphens, which survives being written
 * down and read back. Compared case-insensitively for the same reason usernames
 * are: "Freshsprings" and "freshsprings" are one hospital.
 */
const CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export function normaliseOrganizationCode(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateOrganizationCode(raw: string): string[] {
  const code = normaliseOrganizationCode(raw);
  if (code === "") return ["An organization code is required."];
  if (!CODE_PATTERN.test(code)) {
    return [
      "An organization code is 3–32 characters of lowercase letters, digits and hyphens, starting and ending with a letter or digit.",
    ];
  }
  return [];
}

export function validateOrganizationName(raw: string): string[] {
  const name = raw.trim();
  if (name === "") return ["An organization name is required."];
  if (name.length > 120) return ["An organization name is at most 120 characters."];
  return [];
}
