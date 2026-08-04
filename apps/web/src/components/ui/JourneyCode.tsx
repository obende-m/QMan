import { cn } from "./cn.js";

export type JourneyCodeSize = "inline" | "hero";

export interface JourneyCodeProps {
  code: string;
  size?: JourneyCodeSize;
  className?: string;
}

/**
 * The Journey Code, rendered in JetBrains Mono so patients and staff can scan
 * the alphanumeric sequence quickly — the "technical/precise layer" DESIGN.md
 * reserves the monospace face for.
 *
 * `hero` is the patient portal treatment: the code is the single most important
 * thing on that screen, since it is what the patient reads back over a counter
 * or types into their phone.
 */
export function JourneyCode({
  code,
  size = "inline",
  className,
}: JourneyCodeProps) {
  return (
    <span
      className={cn(
        "font-mono tabular-nums text-primary",
        size === "hero"
          ? "text-display-lg font-bold tracking-tight"
          : "text-body-sm font-semibold",
        className,
      )}
    >
      {code}
    </span>
  );
}
