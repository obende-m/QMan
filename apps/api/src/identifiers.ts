/**
 * Identifier checks at the HTTP boundary.
 *
 * Every tenant-owned row is keyed by a UUID. A path segment that is not one
 * cannot name anything, and handing it to PostgreSQL produces an
 * `invalid_text_representation` error instead of the "not found" the caller
 * should see. Checking the shape first answers it the same way an unknown id
 * is answered, which also stops a malformed id being distinguishable from a
 * well-formed one that belongs to someone else.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * A bounded, trimmed optional string from an untrusted body.
 *
 * `undefined` and `null` mean "not supplied". Anything that is present but not
 * a string, or is longer than the limit, is `invalid` — reported to the caller
 * rather than silently dropped, because a hospital number quietly discarded is
 * a patient who cannot be reconciled against the HMS later.
 */
export function optionalText(
  value: unknown,
  maxLength: number,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length > maxLength) return { ok: false };
  return { ok: true, value: trimmed === "" ? null : trimmed };
}
