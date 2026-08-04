import type { ReactNode } from "react";
import { TrendingDown, TrendingUp, TriangleAlert } from "lucide-react";
import { cn } from "./cn.js";

export type StatTone = "neutral" | "positive" | "warning" | "critical";

const ACCENT: Record<StatTone, string> = {
  neutral: "bg-secondary",
  positive: "bg-tertiary",
  warning: "bg-warning",
  critical: "bg-error",
};

export interface StatCardProps {
  label: string;
  value: string | number;
  /** Rendered smaller, next to the value — "min", "Active Rooms". */
  unit?: string;
  icon?: ReactNode;
  /** Percentage change; sign drives the arrow direction. */
  delta?: { value: number; caption?: string; goodWhen: "up" | "down" };
  /** Replaces the delta with a warning line, e.g. "Above target (15m)". */
  alert?: string;
  /** Draws the coloured underline used on the manager dashboard. */
  accent?: StatTone;
  className?: string;
}

/**
 * The KPI tile used on both the reception and manager dashboards.
 *
 * One component covers both because they differ only in whether the accent
 * underline and icon are present — the alternative was two near-identical tiles
 * drifting apart over time.
 */
export function StatCard({
  label,
  value,
  unit,
  icon,
  delta,
  alert,
  accent,
  className,
}: StatCardProps) {
  const deltaIsGood =
    delta &&
    (delta.goodWhen === "up" ? delta.value >= 0 : delta.value <= 0);

  return (
    <article
      className={cn(
        "relative flex flex-col justify-between overflow-hidden rounded-lg",
        "border border-outline-variant bg-surface-container-lowest p-gutter shadow-card",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-mono text-label-caps uppercase text-on-surface-variant">
          {label}
        </h3>
        {icon && (
          <span aria-hidden="true" className="text-on-surface-variant">
            {icon}
          </span>
        )}
      </div>

      <p className="mt-3 flex items-baseline gap-1.5">
        <span className="text-display-lg font-bold tracking-tight text-on-surface">
          {value}
        </span>
        {unit && (
          <span className="text-title-md font-normal text-on-surface-variant">
            {unit}
          </span>
        )}
      </p>

      {alert ? (
        <p className="mt-2 flex items-center gap-1.5 text-body-sm font-semibold text-error">
          <TriangleAlert aria-hidden="true" className="size-4" />
          {alert}
        </p>
      ) : delta ? (
        <p
          className={cn(
            "mt-2 flex items-center gap-1.5 text-body-sm font-semibold",
            deltaIsGood ? "text-tertiary" : "text-error",
          )}
        >
          {delta.value >= 0 ? (
            <TrendingUp aria-hidden="true" className="size-4" />
          ) : (
            <TrendingDown aria-hidden="true" className="size-4" />
          )}
          {delta.value >= 0 ? "+" : ""}
          {delta.value}%{delta.caption ? ` ${delta.caption}` : ""}
        </p>
      ) : null}

      {accent && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-x-0 bottom-0 h-1",
            ACCENT[accent],
          )}
        />
      )}
    </article>
  );
}
