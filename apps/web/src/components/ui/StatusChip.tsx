import type { Priority, QueueEntryStatus, VisitStatus } from "@qman/domain";
import { cn } from "./cn.js";

/**
 * Status chips, per DESIGN.md: fully pill-shaped so they read as state rather
 * than as something clickable.
 *
 * The variants are derived from the domain's own status unions rather than
 * declared as free-form strings. Adding a visit status to the domain therefore
 * becomes a compile error here until it is given an appearance — the UI cannot
 * silently fail to render a state the engine can produce.
 */
export type ChipTone =
  | "waiting"
  | "in-progress"
  | "completed"
  | "urgent"
  | "neutral";

const TONE_CLASSES: Record<ChipTone, string> = {
  // Warm amber: caution without panic.
  waiting: "bg-warning-container text-on-warning-container",
  // Primary blue at low opacity, primary blue text.
  "in-progress": "bg-primary/10 text-primary",
  // Soft emerald.
  completed: "bg-tertiary-fixed text-on-tertiary-fixed",
  // Solid red, white text, pulsing.
  urgent: "bg-error text-on-error animate-pulse-urgent",
  neutral: "bg-surface-container-high text-on-surface-variant",
};

/** Domain visit status → chip appearance and staff-facing label. */
export function visitStatusChip(status: VisitStatus): {
  tone: ChipTone;
  label: string;
} {
  switch (status) {
    case "created":
      return { tone: "neutral", label: "Registered" };
    case "queued":
      return { tone: "waiting", label: "Waiting" };
    case "called":
      return { tone: "in-progress", label: "Called" };
    case "in_progress":
      return { tone: "in-progress", label: "In Progress" };
    case "completed":
      return { tone: "completed", label: "Completed" };
    case "cancelled":
      return { tone: "neutral", label: "Cancelled" };
    case "closed":
      return { tone: "neutral", label: "Closed" };
  }
}

export function queueStatusChip(status: QueueEntryStatus): {
  tone: ChipTone;
  label: string;
} {
  switch (status) {
    case "waiting":
      return { tone: "waiting", label: "Waiting" };
    case "called":
      return { tone: "in-progress", label: "Called" };
    case "in_progress":
      return { tone: "in-progress", label: "In Progress" };
    case "completed":
      return { tone: "completed", label: "Completed" };
    case "skipped":
      return { tone: "neutral", label: "Skipped" };
    case "cancelled":
      return { tone: "neutral", label: "Cancelled" };
  }
}

export function priorityChip(
  priority: Priority,
): { tone: ChipTone; label: string } | null {
  switch (priority) {
    case "emergency":
      return { tone: "urgent", label: "Emergency" };
    case "high":
      return { tone: "waiting", label: "Urgent" };
    case "vip":
      return { tone: "neutral", label: "VIP" };
    // Normal is the overwhelming majority. Rendering a chip for it would add
    // visual noise to every row while carrying no information.
    case "normal":
      return null;
  }
}

export interface StatusChipProps {
  tone: ChipTone;
  label: string;
  /** Shows the small leading dot used on the reception table's chips. */
  withDot?: boolean;
  className?: string;
}

export function StatusChip({
  tone,
  label,
  withDot = false,
  className,
}: StatusChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1",
        "font-mono text-label-caps uppercase",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {withDot && (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-current opacity-70"
        />
      )}
      {label}
    </span>
  );
}
