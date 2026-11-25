import { useSyncExternalStore } from "react";
import type { ConfigStore } from "./config-store.js";
import { stores } from "./runtime-stores.js";

/**
 * Subscribes a component to the hospital configuration.
 *
 * Separate from `useClinic` on purpose: configuration changes rarely and
 * clinic state changes constantly, so a display board re-rendering on every
 * patient call should not also re-render when nothing about its setup moved.
 */
export function useConfig(store: ConfigStore = stores.config): ConfigStore {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store;
}

/** Common form control classes, so admin inputs stay consistent. */
export const inputClass =
  "w-full rounded border border-outline-variant bg-surface-container-lowest px-3 py-2 " +
  "text-body-sm text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary";

export const labelClass =
  "font-mono text-label-caps uppercase text-on-surface-variant";
