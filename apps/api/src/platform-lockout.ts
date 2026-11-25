/**
 * The platform lockout store, backed by PostgreSQL.
 *
 * A thin adapter between the repository and the service's port, matching
 * `createDatabaseLockoutStore` on the organization side. It exists for the same
 * reason that one does: lockout state must survive a restart and be shared
 * between instances, or an attacker gets a fresh allowance from every process
 * and a deploy clears every lock in the system.
 *
 * The rolling window itself is not interpreted here. It is the domain's, stored
 * and returned unchanged.
 */
import type { LockoutState } from "@qman/domain";
import type { PlatformLockoutRepository } from "@qman/persistence";
import type { PlatformLockoutStore } from "./platform-auth.js";

export function createPlatformLockoutStore(
  repository: PlatformLockoutRepository,
  now: () => Date,
): PlatformLockoutStore {
  return {
    get: (usernameKey) => repository.get(usernameKey),
    set: (usernameKey, state: LockoutState) => repository.set(usernameKey, state, now()),
  };
}
