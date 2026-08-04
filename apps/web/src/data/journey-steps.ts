import {
  orderedStages,
  type StationId,
  type Visit,
  type Workflow,
} from "@qman/domain";
import type { TimelineStep } from "../components/ui/JourneyTimeline.js";
import { stationName } from "./demo-clinic.js";

/**
 * Builds a visit's journey as timeline steps.
 *
 * Deliberately shared: the clinical workspace and the patient portal render the
 * same list, so a patient and their doctor are never looking at different
 * accounts of where the visit has been. Completed steps come from the visit's
 * own queue entries; upcoming steps come from the workflow, so the patient can
 * see what happens next.
 */
export function journeySteps(
  visit: Visit,
  workflow: Workflow,
  options: { includeUpcoming?: boolean } = {},
): TimelineStep[] {
  const { includeUpcoming = true } = options;
  const steps: TimelineStep[] = [];
  const visited = new Set<StationId>();

  for (const entry of visit.queueEntries) {
    visited.add(entry.stationId);
    const name = stationName(entry.stationId);
    const isOpen =
      entry.status === "waiting" ||
      entry.status === "called" ||
      entry.status === "in_progress";

    const detail = detailFor(entry.status, entry.skipped);
    steps.push({
      id: entry.id,
      title: name,
      ...(detail === undefined ? {} : { detail }),
      timestamp: isOpen
        ? entry.status === "waiting"
          ? "NOW"
          : formatClock(entry.calledAt ?? entry.queuedAt)
        : formatClock(entry.completedAt ?? entry.queuedAt),
      state: isOpen ? "current" : "done",
    });
  }

  if (!includeUpcoming) return steps;

  // Anything in the workflow the visit has not reached yet, so the patient can
  // see the road ahead rather than only where they have been.
  const current = visit.currentStationId;
  const currentSequence = current
    ? (orderedStages(workflow).find((s) => s.stationId === current)?.sequence ??
      0)
    : 0;

  for (const stage of orderedStages(workflow)) {
    if (visited.has(stage.stationId)) continue;
    if (stage.sequence <= currentSequence) continue;
    if (!stage.isRequired) continue;
    steps.push({
      id: `upcoming-${stage.id}`,
      title: stationName(stage.stationId),
      state: "upcoming",
    });
  }

  return steps;
}

function detailFor(
  status: string,
  skipped: boolean,
): string | undefined {
  if (status === "waiting") return skipped ? "Waiting — was called" : "Waiting";
  if (status === "called") return "Called";
  if (status === "in_progress") return "In progress";
  if (status === "cancelled") return "Cancelled";
  return undefined;
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
