import { InvariantViolationError } from "../shared/errors.js";
import {
  nextStageInSequence,
  routeOptions,
  stageForStation,
  type Workflow,
} from "./workflow.js";
import type { StationId } from "../shared/ids.js";
import type { Visit } from "../visit/visit.js";

/**
 * What the routing engine decided should happen when a station finishes.
 *
 * Staff never edit queues. They press "Send to Laboratory" or "Complete", and
 * the engine turns that into the sequence of state changes. Returning a decision
 * object rather than performing the change keeps the policy testable in
 * isolation from the aggregate that applies it.
 */
export type RouteDecision =
  | {
      readonly kind: "route";
      readonly toStationId: StationId;
      readonly followedWorkflow: boolean;
    }
  | {
      readonly kind: "complete";
      readonly reason: "workflow_exhausted";
    };

export interface ResolveRouteInput {
  readonly workflow: Workflow;
  readonly visit: Visit;
  /**
   * Where staff asked to send the patient. Omitted means "follow the workflow",
   * which is the path the overwhelming majority of visits take and therefore
   * the one that must require the fewest clicks.
   */
  readonly requestedStationId?: StationId | undefined;
  /**
   * Allows a supervisor to send a patient somewhere the workflow does not
   * permit. Off by default: unconstrained routing is how workflow engines decay
   * into free-text notes.
   */
  readonly allowOffWorkflow?: boolean;
}

/**
 * Decides where a visit goes next.
 *
 * Three cases, in order of frequency:
 *  1. No destination requested → the next stage in sequence, or completion if
 *     the workflow is exhausted.
 *  2. A destination requested that the workflow permits → route there.
 *  3. A destination the workflow does not permit → rejected, unless the caller
 *     holds the override permission.
 */
export function resolveRoute(input: ResolveRouteInput): RouteDecision {
  const { workflow, visit, requestedStationId } = input;

  const currentStationId = visit.currentStationId;
  if (!currentStationId) {
    throw new InvariantViolationError(
      "VISIT_NOT_AT_STATION",
      "Cannot route a visit that is not currently at a station.",
      { visitId: visit.id },
    );
  }

  if (!requestedStationId) {
    const next = nextStageInSequence(workflow, currentStationId);
    if (!next) {
      return { kind: "complete", reason: "workflow_exhausted" };
    }
    return {
      kind: "route",
      toStationId: next.stationId,
      followedWorkflow: true,
    };
  }

  if (requestedStationId === currentStationId) {
    throw new InvariantViolationError(
      "ROUTE_TO_SAME_STATION",
      "A visit cannot be routed to the station it is already at.",
      { stationId: requestedStationId },
    );
  }

  const permitted = routeOptions(workflow, currentStationId);
  const match = permitted.find((o) => o.stationId === requestedStationId);

  if (match) {
    return {
      kind: "route",
      toStationId: match.stationId,
      followedWorkflow: match.isNextInSequence,
    };
  }

  // Returning to a stage already passed — consultation after a lab test — is
  // legal when that stage was configured to allow repeats.
  const target = stageForStation(workflow, requestedStationId);
  if (target?.allowRepeat) {
    return {
      kind: "route",
      toStationId: requestedStationId,
      followedWorkflow: false,
    };
  }

  if (input.allowOffWorkflow) {
    return {
      kind: "route",
      toStationId: requestedStationId,
      followedWorkflow: false,
    };
  }

  throw new InvariantViolationError(
    "ROUTE_NOT_PERMITTED",
    target
      ? `Workflow "${workflow.name}" does not allow returning to this station.`
      : `Workflow "${workflow.name}" does not include this station.`,
    {
      workflowId: workflow.id,
      fromStationId: currentStationId,
      toStationId: requestedStationId,
      permitted: permitted.map((o) => o.stationId),
    },
  );
}

/**
 * The destinations a station's UI should offer for a visit, most likely first.
 * Completion is offered when the workflow has no further required stage.
 */
export function availableDestinations(
  workflow: Workflow,
  currentStationId: StationId,
): {
  readonly options: ReturnType<typeof routeOptions>;
  readonly canComplete: boolean;
} {
  const options = routeOptions(workflow, currentStationId);
  const next = nextStageInSequence(workflow, currentStationId);
  return {
    options,
    canComplete: !next || !next.isRequired,
  };
}
