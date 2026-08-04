import { useEffect, useState } from "react";
import {
  DEFAULT_CONNECTION_THRESHOLDS,
  assessConnection,
  describeConnection,
  formatFreshness,
  type ConnectionSnapshot,
  type ConnectionThresholds,
} from "@qman/domain";
import { cn } from "./cn.js";

/**
 * Honest connection status, shared by every surface that claims to be live.
 *
 * A screen asserting "Live" while rendering data it stopped receiving is not a
 * cosmetic problem. In a clinical setting, stale information presented as
 * current is more dangerous than no information at all, because staff and
 * patients act on it.
 *
 * The same component serves the display board, the patient tracker, station
 * workspaces and the command centre, so the answer is consistent wherever
 * somebody happens to be looking.
 */

/**
 * Tracks how long it has been since a data source last reported.
 *
 * The source calls `markUpdate()`; this hook decays through stale to offline
 * when it stops. Today the source is in-process, so a healthy app stays
 * "Live" — the value is that the moment there is a network between the screen
 * and the data, the indicator is already correct rather than being retrofitted
 * after the first frozen board.
 */
export function useConnectionMonitor(options: {
  /** Bump this whenever the source reports; usually a store version. */
  signal: number;
  /** False once the surface has stopped trying to reach its source. */
  attempting?: boolean;
  thresholds?: ConnectionThresholds;
  /** How often to re-evaluate freshness. */
  tickMillis?: number;
}): ConnectionSnapshot {
  const {
    signal,
    attempting = true,
    thresholds = DEFAULT_CONNECTION_THRESHOLDS,
    tickMillis = 1000,
  } = options;

  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    setLastUpdatedAt(new Date());
  }, [signal]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), tickMillis);
    return () => clearInterval(timer);
  }, [tickMillis]);

  return assessConnection({ lastUpdatedAt, attempting, now, thresholds });
}

const TONE_CLASSES = {
  healthy: { dot: "bg-tertiary", text: "text-tertiary" },
  warning: { dot: "bg-warning", text: "text-warning" },
  degraded: { dot: "bg-warning", text: "text-warning" },
  critical: { dot: "bg-error", text: "text-error" },
} as const;

export interface ConnectionStatusProps {
  snapshot: ConnectionSnapshot;
  /** `board` is sized for a wall screen; `inline` for a staff toolbar. */
  size?: "inline" | "board";
  /** Always show the freshness line, not only when degraded. */
  alwaysShowFreshness?: boolean;
  className?: string;
}

export function ConnectionStatus({
  snapshot,
  size = "inline",
  alwaysShowFreshness = false,
  className,
}: ConnectionStatusProps) {
  const description = describeConnection(snapshot);
  const tone = TONE_CLASSES[description.tone];
  const isBoard = size === "board";

  // The freshness line is the part that makes the status actionable: "Data may
  // be outdated" is a warning, "Updated 2m 14s ago" is a number someone can
  // judge for themselves.
  const showFreshness = alwaysShowFreshness || !snapshot.trustworthy;

  return (
    <div
      // A degraded surface is worth announcing; a healthy one changing nothing
      // must not chatter at a screen reader every second.
      role="status"
      aria-live={snapshot.trustworthy ? "off" : "polite"}
      className={cn("text-right", className)}
    >
      <p
        className={cn(
          "flex items-center justify-end gap-2 font-mono uppercase",
          isBoard ? "text-body-md" : "text-label-caps",
          tone.text,
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "rounded-full",
            isBoard ? "size-3" : "size-2",
            tone.dot,
            // Only a healthy connection pulses. A frozen board with a cheerful
            // blinking dot is exactly the lie this component exists to stop.
            snapshot.state === "connected" && "animate-pulse-urgent",
          )}
        />
        {description.label}
      </p>

      {showFreshness && (
        <p
          className={cn(
            "text-on-surface-variant",
            isBoard ? "text-body-md" : "text-body-sm",
          )}
        >
          {formatFreshness(snapshot)}
        </p>
      )}

      {isBoard && !snapshot.trustworthy && (
        <p className="mt-1 max-w-xs text-body-sm text-on-surface-variant">
          {description.detail}
        </p>
      )}
    </div>
  );
}
