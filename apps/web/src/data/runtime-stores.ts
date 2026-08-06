/**
 * The composition root.
 *
 * One place that constructs the stores and wires them to the API and the event
 * stream. Everything else receives a store rather than reaching for a
 * singleton, which is what lets a test build its own against fake responses
 * instead of resetting shared state between cases.
 *
 * Nothing is seeded. An empty hospital is a hospital with no patients in it,
 * and every surface renders that correctly — which is a property worth having
 * on the first morning of a real deployment, when it is also the truth.
 */
import { randomId } from "./ids.js";
import { ApiClient } from "../api/client.js";
import { EventStreamClient } from "../api/stream.js";
import { ActivityApi } from "./activity-api.js";
import { AuthApi } from "./auth-api.js";
import { AuthStore } from "./auth-store.js";
import { ClinicStore } from "./clinic-store.js";
import { ConfigStore } from "./config-store.js";
import { ConfigurationApi } from "./configuration-api.js";
import { VisitsApi } from "./visits-api.js";

/**
 * Where the API lives.
 *
 * Empty means same-origin, which is how a hospital serving both from one
 * machine is configured. A deployment that splits them sets this at build time.
 */
const API_BASE_URL = (import.meta.env["VITE_API_URL"] as string | undefined) ?? "";

export interface Stores {
  readonly auth: AuthStore;
  readonly config: ConfigStore;
  readonly clinic: ClinicStore;
  readonly stream: EventStreamClient;
  readonly activity: ActivityApi;
}

export function createStores(baseUrl: string = API_BASE_URL): Stores {
  const client = new ApiClient({ baseUrl });
  const deps = { clock: { now: () => new Date() }, ids: { next: randomId } };

  const auth = new AuthStore(new AuthApi(client));
  const config = new ConfigStore(new ConfigurationApi(client));
  const clinic = new ClinicStore(new VisitsApi(client), config, deps);
  const activity = new ActivityApi(client);
  const stream = new EventStreamClient({ url: `${baseUrl}/api/v1/stream` });

  /**
   * The stream invalidates; it does not patch.
   *
   * An event says something changed and the store re-reads. Applying payloads
   * directly would mean a second reducer that has to agree with the aggregate,
   * and it would diverge the first time an event was missed — which every
   * reconnection guarantees.
   */
  stream.onEvent(() => {
    void clinic.invalidate();
  });


  return { auth, config, clinic, stream, activity };
}

/**
 * The stores this browser tab is using.
 *
 * A module-level instance because a tab is one session looking at one hospital.
 * Tests never touch it: they call `createStores` with their own transport.
 */
export const stores = createStores();
