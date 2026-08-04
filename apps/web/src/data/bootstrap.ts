import { EventBus } from "./event-bus.js";
import { clinicStore } from "./clinic-store.js";
import { operationsStore } from "./operations-store.js";
import { configStore } from "./config-store.js";
import { authStore } from "./auth-store.js";
import { Notifier } from "../runtime/notifier.js";
import { browserNotifications } from "../runtime/ports.js";
import { LocalIdentityProvider } from "../runtime/local-provider.js";
import { UserId, type UserAccount } from "@qman/domain";

/**
 * Wires the platform together.
 *
 * One place where the clinic engine, the event bus and the operational
 * subscribers meet. Everything else stays ignorant of everything else: the
 * queue engine publishes, the subscribers consume, and neither imports the
 * other.
 *
 * When the API arrives this file changes and nothing above it does — the bus is
 * fed by a websocket instead of by the local store.
 */
export const eventBus = new EventBus();

clinicStore.useBus(eventBus);
operationsStore.attachTo(eventBus);

/**
 * Configuration and authentication record themselves.
 *
 * Wired here rather than inside those stores, so neither knows what an audit
 * log is — and so "who changed this SLA" is answered without anyone having
 * remembered to log it at the call site.
 */
configStore.auditTo(({ type, summary }) =>
  operationsStore.recordAdminEvent({
    type,
    summary,
    actorId: authStore.currentUser()?.account.id ?? null,
    correlationId: authStore.currentSession()?.id ?? null,
  }),
);

authStore.auditTo(({ type, summary, actorId, correlationId }) =>
  operationsStore.recordSecurityEvent({ type, summary, actorId, correlationId }),
);

/**
 * Staff notifications. Subscribed per-station by whichever workspace is open,
 * rather than globally — a doctor should hear about their own queue, not every
 * queue in the hospital.
 */
export const staffNotifier = new Notifier({
  notifications: browserNotifications(),
  operations: operationsStore,
  config: configStore,
});

/**
 * Local accounts for the pilot.
 *
 * Seeded here because there is no persistence yet. When the database lands
 * these come from it, and this block disappears rather than moving.
 */
export const localProvider = new LocalIdentityProvider();
authStore.registerProvider(localProvider);

const SEED_ACCOUNTS: readonly UserAccount[] = [
  {
    id: UserId("user-reception"),
    displayName: "Ifeoma Balogun",
    username: "ifeoma",
    roleId: "role-receptionist",
    branchIds: [],
    providerId: "local",
    enabled: true,
  },
  {
    id: UserId("user-doctor"),
    displayName: "Dr Adams",
    username: "adams",
    roleId: "role-clinician",
    branchIds: [],
    providerId: "local",
    enabled: true,
  },
  {
    id: UserId("user-admin"),
    displayName: "System Administrator",
    username: "admin",
    roleId: "role-administrator",
    branchIds: [],
    providerId: "local",
    enabled: true,
  },
];

/**
 * The password every seeded account is given.
 *
 * Generated fresh on each start and printed once, rather than written into the
 * source. A password committed to a repository is a password that reaches every
 * clone, every fork and every future deployment that forgets to change it.
 *
 * `VITE_SEED_PASSWORD` overrides it for a shared development environment where
 * a stable login is convenient.
 */
function seedPassword(): { value: string; generated: boolean } {
  const configured = import.meta.env["VITE_SEED_PASSWORD"];
  if (typeof configured === "string" && configured.length > 0) {
    return { value: configured, generated: false };
  }

  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const value = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { value, generated: true };
}

void (async () => {
  const { value, generated } = seedPassword();

  await Promise.all(
    SEED_ACCOUNTS.map(async (account) => {
      await localProvider.addAccount(account, value);
      authStore.addAccount(account);
    }),
  );

  if (generated && import.meta.env.DEV) {
    // Printed once so a developer can sign in, in the same spirit as a database
    // that prints its initial administrator password on first boot.
    console.info(
      `[qman] Development sign-in — users: ${SEED_ACCOUNTS.map((a) => a.username).join(", ")} · password: ${value}`,
    );
  }
})();

/**
 * Source keepalive.
 *
 * Stands in for the transport that will later feed the stores over a socket.
 * Real-time surfaces judge their freshness against this, so if the source ever
 * stops the display board says so rather than showing a frozen queue under a
 * "Live" badge.
 */
if (typeof window !== "undefined") {
  window.setInterval(() => clinicStore.keepAlive(), 15_000);
}

export { authStore, clinicStore, operationsStore };
