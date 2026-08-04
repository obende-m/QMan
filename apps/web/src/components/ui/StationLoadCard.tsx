import type { ReactNode } from "react";
import { cn } from "./cn.js";

export type LoadLevel = "low" | "normal" | "high";

const BAR: Record<LoadLevel, string> = {
  low: "bg-tertiary",
  normal: "bg-primary",
  high: "bg-error",
};

const LABEL: Record<LoadLevel, string> = {
  low: "Low load",
  normal: "Normal load",
  high: "High load",
};

/**
 * Classifies a station's load from its queue depth against the point at which
 * that station is considered saturated.
 *
 * Thresholds are a ratio rather than absolute counts because a five-person
 * queue means something very different at Radiology than at Reception. The
 * saturation point is per-station configuration, not a constant.
 */
export function loadLevel(waiting: number, saturationPoint: number): LoadLevel {
  const ratio = waiting / Math.max(1, saturationPoint);
  if (ratio >= 0.8) return "high";
  if (ratio >= 0.35) return "normal";
  return "low";
}

export interface StationLoadCardProps {
  name: string;
  waiting: number;
  saturationPoint: number;
  icon: ReactNode;
  selected?: boolean;
  onSelect?: () => void;
}

export function StationLoadCard({
  name,
  waiting,
  saturationPoint,
  icon,
  selected = false,
  onSelect,
}: StationLoadCardProps) {
  const level = loadLevel(waiting, saturationPoint);
  const fill = Math.min(100, Math.round((waiting / Math.max(1, saturationPoint)) * 100));

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-md border p-4 text-left transition-colors",
        selected
          ? "border-primary bg-surface-container-lowest ring-1 ring-primary"
          : "border-outline-variant bg-surface-container-low hover:bg-surface-container-high",
      )}
    >
      {/* The source design clipped the "WAITING" chip when a station name ran
          long. The name truncates and the chip never shrinks, so the count —
          the only number that matters here — is always fully legible. */}
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded",
            selected
              ? "bg-primary text-on-primary"
              : "bg-surface-container-high text-on-surface-variant",
          )}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-body-md font-semibold text-on-surface">
          {name}
        </span>
        <span className="shrink-0 whitespace-nowrap rounded bg-surface-container-high px-2 py-1 font-mono text-label-caps uppercase text-on-surface-variant">
          {waiting} waiting
        </span>
      </div>

      <div>
        <div
          role="meter"
          aria-valuenow={waiting}
          aria-valuemin={0}
          aria-valuemax={saturationPoint}
          aria-label={`${name} queue: ${waiting} waiting, ${LABEL[level].toLowerCase()}`}
          className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high"
        >
          <div
            className={cn("h-full rounded-full transition-all", BAR[level])}
            style={{ width: `${Math.max(4, fill)}%` }}
          />
        </div>
        <p className="mt-2 text-right text-body-sm text-on-surface-variant">
          {LABEL[level]}
        </p>
      </div>
    </button>
  );
}
