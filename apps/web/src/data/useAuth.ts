import { useSyncExternalStore } from "react";
import { AuthStore, authStore } from "./auth-store.js";

export function useAuth(store: AuthStore = authStore): AuthStore {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store;
}
