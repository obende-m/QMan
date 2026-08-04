import { useSyncExternalStore } from "react";
import { OperationsStore, operationsStore } from "./operations-store.js";

/**
 * Subscribes a component to operational telemetry.
 *
 * Separate from `useClinic` and `useConfig` so the three change at their own
 * rates: patient flow moves constantly, telemetry moves on heartbeats, and
 * configuration barely moves at all.
 */
export function useOperations(
  store: OperationsStore = operationsStore,
): OperationsStore {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store;
}
