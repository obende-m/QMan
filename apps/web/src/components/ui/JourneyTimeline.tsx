import { Check } from "lucide-react";
import { cn } from "./cn.js";

export type TimelineState = "done" | "current" | "upcoming";

export interface TimelineStep {
  id: string;
  title: string;
  detail?: string;
  /** Rendered in the monospace label style, e.g. "09:15 AM" or "NOW". */
  timestamp?: string;
  state: TimelineState;
}

export interface JourneyTimelineProps {
  steps: readonly TimelineStep[];
  className?: string;
}

/**
 * The vertical journey track shared by the patient portal and the clinical
 * workspace's Clinical Summary. Per DESIGN.md: a dashed 2px track with
 * milestone iconography.
 *
 * It renders the same `VisitActivity` history in both places, which is what
 * keeps the patient's view and the clinician's view of a journey identical —
 * they are literally the same list.
 */
export function JourneyTimeline({ steps, className }: JourneyTimelineProps) {
  return (
    <ol className={cn("relative", className)}>
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;
        return (
          <li key={step.id} className="relative flex gap-4 pb-7 last:pb-0">
            {!isLast && (
              <span
                aria-hidden="true"
                className="absolute left-[11px] top-6 h-full border-l-2 border-dashed border-outline-variant"
              />
            )}

            <span
              aria-hidden="true"
              className={cn(
                "relative z-10 mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border-2",
                step.state === "done" &&
                  "border-tertiary bg-surface-container-lowest text-tertiary",
                step.state === "current" &&
                  "border-warning bg-surface-container-lowest text-warning",
                step.state === "upcoming" &&
                  "border-outline-variant bg-surface-container-lowest text-outline",
              )}
            >
              {step.state === "done" ? (
                <Check className="size-3.5" strokeWidth={3} />
              ) : (
                <span
                  className={cn(
                    "size-2 rounded-full",
                    step.state === "current" ? "bg-warning" : "bg-transparent",
                  )}
                />
              )}
            </span>

            <div className="flex min-w-0 flex-1 items-start justify-between gap-4">
              <div className="min-w-0">
                <p
                  className={cn(
                    "text-body-md font-semibold",
                    step.state === "upcoming"
                      ? "text-on-surface-variant"
                      : "text-on-surface",
                  )}
                >
                  {step.title}
                </p>
                {step.detail && (
                  <p
                    className={cn(
                      "mt-0.5 text-body-sm",
                      step.state === "current"
                        ? "text-warning"
                        : "text-on-surface-variant",
                    )}
                  >
                    {step.detail}
                  </p>
                )}
              </div>
              {step.timestamp && (
                <span
                  className={cn(
                    "shrink-0 font-mono text-label-caps uppercase",
                    step.state === "current"
                      ? "text-primary"
                      : "text-on-surface-variant",
                  )}
                >
                  {step.timestamp}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
