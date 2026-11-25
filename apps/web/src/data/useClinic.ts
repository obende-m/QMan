import { useEffect, useState, useSyncExternalStore } from "react";
import type { ClinicStore } from "./clinic-store.js";
import { stores } from "./runtime-stores.js";

/**
 * Subscribes a component to the clinic store.
 *
 * Returns the store itself rather than a derived slice: the store's query
 * methods are cheap projections over an in-memory array, and re-deriving them
 * on render keeps every screen consistent with a single version number instead
 * of a web of memoised selectors that can disagree.
 */
export function useClinic(store: ClinicStore = stores.clinic): ClinicStore {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store;
}

/**
 * A ticking clock for live durations — "time in consult", "waiting 45m".
 *
 * These counters are the most-watched numbers on a station screen, so they
 * update on their own rather than only when someone acts.
 */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}

/** Formats a duration the way staff read it: "45m", "1h 12m", "0:47". */
export function formatDuration(millis: number): string {
  const totalMinutes = Math.floor(millis / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m`;
}

/** Stopwatch format for the active consultation timer: "14:23". */
export function formatStopwatch(millis: number): string {
  const totalSeconds = Math.max(0, Math.floor(millis / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
