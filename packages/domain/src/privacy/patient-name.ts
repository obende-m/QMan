/**
 * How much of a patient's name may be shown on a given surface.
 *
 * This lives in the domain, not in a display component, because it is a
 * hospital policy rather than a styling choice — and because the same rule has
 * to govern SMS bodies, push notifications and printed tickets once those
 * exist. A policy enforced in one component is a policy that leaks the first
 * time a second component renders a name.
 */
export const PATIENT_NAME_POLICIES = [
  "ticket_only",
  "first_name",
  "full_name",
] as const;

export type PatientNamePolicy = (typeof PATIENT_NAME_POLICIES)[number];

/**
 * Ticket-only is the default everywhere it is not overridden. A queue number is
 * sufficient to call a patient forward, and a name on a public screen is an
 * exposure that is trivial to avoid at design time.
 */
export const DEFAULT_PATIENT_NAME_POLICY: PatientNamePolicy = "ticket_only";

/**
 * Applies the policy. Returns null when no name may be shown, so callers must
 * handle absence explicitly rather than rendering an empty string.
 */
export function displayPatientName(
  fullName: string,
  policy: PatientNamePolicy,
): string | null {
  const name = fullName.trim();
  if (name.length === 0) return null;

  switch (policy) {
    case "ticket_only":
      return null;
    case "full_name":
      return name;
    case "first_name": {
      // Take the leading token. Falls back to the whole name for mononyms,
      // which are common across the markets QMan targets and must not render
      // as blank.
      const [first] = name.split(/\s+/);
      return first ?? name;
    }
  }
}

/** Human-readable description, for the administration UI. */
export function describeNamePolicy(policy: PatientNamePolicy): string {
  switch (policy) {
    case "ticket_only":
      return "Ticket number only";
    case "first_name":
      return "Ticket number and first name";
    case "full_name":
      return "Ticket number and full name";
  }
}
