/**
 * Identifiers the browser needs.
 *
 * Used for idempotency keys, which is the only thing this generates. Visit and
 * queue-entry identifiers are the server's — a client that minted one could
 * collide with an existing row, or resurrect a deleted one and inherit its
 * history.
 *
 * `crypto.randomUUID` where it exists. The fallback is not a security boundary:
 * a key only has to be unique among one tab's in-flight actions, and a
 * collision would at worst replay that tab's own response to itself.
 */
export function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
