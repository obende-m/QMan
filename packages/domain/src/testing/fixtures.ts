import { FixedClock } from "../shared/clock.js";
import {
  BranchId,
  StationId,
  WorkflowId,
  WorkflowStageId,
  type IdGenerator,
} from "../shared/ids.js";
import type { RandomSource } from "../journey/journey-code.js";
import type { QueueTicket } from "../queue/queue-number.js";
import type { Workflow, WorkflowStage } from "../workflow/workflow.js";
import type { VisitDependencies } from "../visit/visit.js";

/** Deterministic ids so assertions can name them. */
export class SequentialIds implements IdGenerator {
  #n = 0;
  constructor(private readonly prefix = "id") {}
  next(): string {
    this.#n += 1;
    return `${this.prefix}-${this.#n}`;
  }
}

/** Deterministic "randomness" for journey-code tests. */
export class CyclingRandom implements RandomSource {
  #i = 0;
  constructor(private readonly values: readonly number[] = [0]) {}
  nextInt(maxExclusive: number): number {
    const value = this.values[this.#i % this.values.length]!;
    this.#i += 1;
    return value % maxExclusive;
  }
}

export const BRANCH = BranchId("branch-main");

/** A queue ticket for tests, where the exact label rarely matters. */
export function ticket(ordinal: number, label?: string): QueueTicket {
  return {
    ordinal,
    label: label ?? String(ordinal).padStart(3, "0"),
    periodKey: "test-period",
  };
}

export const STATIONS = {
  reception: StationId("st-reception"),
  vitals: StationId("st-vitals"),
  consultation: StationId("st-consultation"),
  laboratory: StationId("st-laboratory"),
  pharmacy: StationId("st-pharmacy"),
  radiology: StationId("st-radiology"),
} as const;

export function makeDeps(
  clock = new FixedClock(),
): VisitDependencies & { clock: FixedClock } {
  return { clock, ids: new SequentialIds("qe") };
}

function stage(
  stationId: StationId,
  sequence: number,
  overrides: Partial<Omit<WorkflowStage, "stationId" | "sequence" | "id">> = {},
): WorkflowStage {
  return {
    id: WorkflowStageId(`stage-${sequence}`),
    stationId,
    sequence,
    isRequired: true,
    allowSkip: false,
    allowRepeat: false,
    branchesTo: [],
    ...overrides,
  };
}

/**
 * The PRD's General Outpatient workflow, extended with the clinical detour the
 * SAD's example journey requires: consultation may branch to laboratory or
 * radiology, and consultation allows repeats so the patient can come back for
 * results review.
 */
export function generalOutpatientWorkflow(): Workflow {
  return {
    id: WorkflowId("wf-opd"),
    branchId: BRANCH,
    name: "General Outpatient",
    isDefault: true,
    stages: [
      stage(STATIONS.reception, 1),
      stage(STATIONS.vitals, 2),
      stage(STATIONS.consultation, 3, {
        allowRepeat: true,
        branchesTo: [STATIONS.laboratory, STATIONS.radiology],
      }),
      stage(STATIONS.laboratory, 4, {
        isRequired: false,
        branchesTo: [STATIONS.consultation],
      }),
      stage(STATIONS.radiology, 5, {
        isRequired: false,
        branchesTo: [STATIONS.consultation],
      }),
      stage(STATIONS.pharmacy, 6, { isRequired: false }),
    ],
  };
}

/** A minimal two-stage workflow: Reception → Laboratory. */
export function laboratoryOnlyWorkflow(): Workflow {
  return {
    id: WorkflowId("wf-lab"),
    branchId: BRANCH,
    name: "Laboratory Only",
    isDefault: false,
    stages: [stage(STATIONS.reception, 1), stage(STATIONS.laboratory, 2)],
  };
}
