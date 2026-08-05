import { useSyncExternalStore } from "react";
import type { AuthStore } from "./auth-store.js";
import { stores } from "./runtime-stores.js";

export function useAuth(store: AuthStore = stores.auth): AuthStore {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store;
}
