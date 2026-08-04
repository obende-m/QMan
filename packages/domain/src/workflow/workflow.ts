import { InvariantViolationError } from "../shared/errors.js";
import type {
  BranchId,
  StationId,
  WorkflowId,
  WorkflowStageId,
} from "../shared/ids.js";

export interface WorkflowStage {
  readonly id: WorkflowStageId;
  readonly stationId: StationId;
  /** 1-based position in the default path. */
  readonly sequence: number;
  readonly isRequired: boolean;
  /** May staff advance past this stage without servicing it? */
  readonly allowSkip: boolean;
  /** May a visit return to this stage after having completed it? */
  readonly allowRepeat: boolean;
  /**
   * Stations this stage may route to in addition to the next in sequence.
   * Empty means "sequence only". This is what turns a linear list into a graph
   * without requiring administrators to draw one.
   */
  readonly branchesTo: readonly StationId[];
}

export interface Workflow {
  readonly id: WorkflowId;
  readonly branchId: BranchId;
  readonly name: string;
  readonly isDefault: boolean;
  readonly stages: readonly WorkflowStage[];
}

export interface RouteOption {
  readonly stationId: StationId;
  readonly stageId: WorkflowStageId;
  /** True for the workflow's own next step — the UI should make this primary. */
  readonly isNextInSequence: boolean;
  readonly isRequired: boolean;
}

/** Stages sorted by sequence. Stored order is never trusted. */
export function orderedStages(workflow: Workflow): readonly WorkflowStage[] {
  return [...workflow.stages].sort((a, b) => a.sequence - b.sequence);
}

export function firstStage(workflow: Workflow): WorkflowStage {
  const first = orderedStages(workflow)[0];
  if (!first) {
    throw new InvariantViolationError(
      "WORKFLOW_EMPTY",
      `Workflow "${workflow.name}" has no stages and cannot admit a visit.`,
      { workflowId: workflow.id },
    );
  }
  return first;
}

export function stageForStation(
  workflow: Workflow,
  stationId: StationId,
): WorkflowStage | undefined {
  return orderedStages(workflow).find((s) => s.stationId === stationId);
}

/**
 * The stage that follows `stationId` in sequence, or undefined if it is last.
 */
export function nextStageInSequence(
  workflow: Workflow,
  stationId: StationId,
): WorkflowStage | undefined {
  const stages = orderedStages(workflow);
  const index = stages.findIndex((s) => s.stationId === stationId);
  if (index === -1) return undefined;
  return stages[index + 1];
}

/**
 * Everywhere a visit at `stationId` is allowed to go next.
 *
 * Staff pick from this list rather than typing a destination, which is what
 * keeps routing correct-by-construction while still allowing the clinical
 * detours real hospitals need (consultation → lab → back to consultation).
 */
export function routeOptions(
  workflow: Workflow,
  stationId: StationId,
): readonly RouteOption[] {
  const stages = orderedStages(workflow);
  const current = stages.find((s) => s.stationId === stationId);
  const next = nextStageInSequence(workflow, stationId);

  const options = new Map<StationId, RouteOption>();

  if (next) {
    options.set(next.stationId, {
      stationId: next.stationId,
      stageId: next.id,
      isNextInSequence: true,
      isRequired: next.isRequired,
    });
  }

  for (const target of current?.branchesTo ?? []) {
    if (options.has(target)) continue;
    const stage = stages.find((s) => s.stationId === target);
    if (!stage) continue;
    options.set(target, {
      stationId: stage.stationId,
      stageId: stage.id,
      isNextInSequence: false,
      isRequired: stage.isRequired,
    });
  }

  return [...options.values()];
}

/**
 * Validates a workflow definition at configuration time.
 *
 * Administrators build workflows without a developer, so the errors they can
 * make must be caught when they save — not when a patient is standing at the
 * desk. Returns human-readable problems; empty means valid.
 */
export function validateWorkflow(workflow: Workflow): string[] {
  const problems: string[] = [];
  const stages = orderedStages(workflow);

  if (stages.length === 0) {
    problems.push("A workflow must contain at least one stage.");
    return problems;
  }

  const sequences = new Set<number>();
  for (const stage of stages) {
    if (sequences.has(stage.sequence)) {
      problems.push(`Two stages share sequence ${stage.sequence}.`);
    }
    sequences.add(stage.sequence);
  }

  const stationIds = new Set(stages.map((s) => s.stationId));
  if (stationIds.size !== stages.length) {
    problems.push(
      "A station appears more than once. Use allowRepeat and branchesTo to " +
        "revisit a station instead of listing it twice.",
    );
  }

  for (const stage of stages) {
    for (const target of stage.branchesTo) {
      if (!stationIds.has(target)) {
        problems.push(
          `A stage branches to a station that is not part of this workflow.`,
        );
      }
    }
  }

  return problems;
}
