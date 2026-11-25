/**
 * Visit priority.
 *
 * The PRD lists Emergency, High, Normal and VIP without an ordering. Encoding
 * them as weights rather than as an enum position makes the ranking explicit and
 * lets an administrator retune it later without a schema migration.
 *
 * The default ranking places VIP *below* clinical urgency deliberately: a
 * commercial courtesy tier must never outrank a patient who is clinically
 * urgent. VIP outranks Normal only.
 */
export const PRIORITIES = ["emergency", "high", "vip", "normal"] as const;

export type Priority = (typeof PRIORITIES)[number];

export const DEFAULT_PRIORITY: Priority = "normal";

/**
 * Narrows untrusted input to a priority.
 *
 * Priority arrives over the wire as a string, and a value outside the set is
 * not a lower priority — it is a visit the mapper cannot read back. One such
 * row used to make every read of its branch fail, so the check belongs at every
 * boundary a priority crosses: here, the API, and a CHECK constraint.
 */
export function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);
}

/** Higher weight is served first. */
export const DEFAULT_PRIORITY_WEIGHTS: Readonly<Record<Priority, number>> =
  Object.freeze({
    emergency: 300,
    high: 200,
    vip: 100,
    normal: 0,
  });

export function priorityWeight(
  priority: Priority,
  weights: Readonly<Record<Priority, number>> = DEFAULT_PRIORITY_WEIGHTS,
): number {
  return weights[priority];
}
