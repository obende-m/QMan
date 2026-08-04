import { beforeEach, describe, expect, it } from "vitest";
import { availableDestinations, resolveRoute } from "./routing.js";
import {
  firstStage,
  nextStageInSequence,
  orderedStages,
  routeOptions,
  validateWorkflow,
} from "./workflow.js";
import { Visit } from "../visit/visit.js";
import { parseJourneyCode } from "../journey/journey-code.js";
import { InvariantViolationError } from "../shared/errors.js";
import { StationId, UserId, WorkflowStageId } from "../shared/ids.js";
import {
  BRANCH,
  STATIONS,
  generalOutpatientWorkflow,
  laboratoryOnlyWorkflow,
  makeDeps,
  ticket,
} from "../testing/fixtures.js";

const DOCTOR = UserId("user-doctor");

function visitAt(stationId: StationId): Visit {
  const deps = makeDeps();
  const workflow = generalOutpatientWorkflow();
  const visit = Visit.create(
    {
      journeyCode: parseJourneyCode("QM-8F4K"),
      branchId: BRANCH,
      workflowId: workflow.id,
      patient: { name: "Test Patient", hospitalNumber: null, phone: null },
    },
    deps,
  );
  visit.enqueue(stationId, ticket(1));
  visit.pullEvents();
  return visit;
}

describe("workflow definition", () => {
  it("orders stages by sequence regardless of stored order", () => {
    const workflow = generalOutpatientWorkflow();
    const shuffled = { ...workflow, stages: [...workflow.stages].reverse() };
    expect(orderedStages(shuffled).map((s) => s.stationId)).toEqual(
      orderedStages(workflow).map((s) => s.stationId),
    );
    expect(firstStage(shuffled).stationId).toBe(STATIONS.reception);
  });

  it("catches configuration mistakes before a patient hits them", () => {
    const workflow = generalOutpatientWorkflow();
    expect(validateWorkflow(workflow)).toEqual([]);

    expect(validateWorkflow({ ...workflow, stages: [] })).toContain(
      "A workflow must contain at least one stage.",
    );

    const duplicated = {
      ...workflow,
      stages: [workflow.stages[0]!, { ...workflow.stages[1]!, sequence: 1 }],
    };
    expect(validateWorkflow(duplicated).join(" ")).toMatch(/share sequence 1/);

    const danglingBranch = {
      ...workflow,
      stages: [
        {
          ...workflow.stages[0]!,
          branchesTo: [StationId("st-not-in-workflow")],
        },
        workflow.stages[1]!,
      ],
    };
    expect(validateWorkflow(danglingBranch).join(" ")).toMatch(
      /branches to a station that is not part of this workflow/,
    );
  });

  it("offers the next stage plus any configured branches", () => {
    const workflow = generalOutpatientWorkflow();
    const options = routeOptions(workflow, STATIONS.consultation);

    expect(options.map((o) => o.stationId)).toEqual([
      STATIONS.laboratory, // next in sequence
      STATIONS.radiology, // configured branch
    ]);
    expect(options.find((o) => o.stationId === STATIONS.laboratory)).toMatchObject(
      { isNextInSequence: true },
    );
    expect(options.find((o) => o.stationId === STATIONS.radiology)).toMatchObject(
      { isNextInSequence: false },
    );
  });

  it("does not list a branch twice when it is also the next stage", () => {
    const workflow = generalOutpatientWorkflow();
    const withRedundantBranch = {
      ...workflow,
      stages: workflow.stages.map((s) =>
        s.stationId === STATIONS.vitals
          ? { ...s, branchesTo: [STATIONS.consultation] }
          : s,
      ),
    };
    const options = routeOptions(withRedundantBranch, STATIONS.vitals);
    expect(options).toHaveLength(1);
    expect(options[0]!.isNextInSequence).toBe(true);
  });

  it("reports no next stage at the end of a workflow", () => {
    const workflow = laboratoryOnlyWorkflow();
    expect(nextStageInSequence(workflow, STATIONS.laboratory)).toBeUndefined();
  });
});

describe("routing engine", () => {
  let workflow: ReturnType<typeof generalOutpatientWorkflow>;

  beforeEach(() => {
    workflow = generalOutpatientWorkflow();
  });

  it("follows the workflow when no destination is requested", () => {
    const decision = resolveRoute({
      workflow,
      visit: visitAt(STATIONS.reception),
    });
    expect(decision).toEqual({
      kind: "route",
      toStationId: STATIONS.vitals,
      followedWorkflow: true,
    });
  });

  it("completes the journey when the workflow is exhausted", () => {
    const decision = resolveRoute({
      workflow,
      visit: visitAt(STATIONS.pharmacy),
    });
    expect(decision).toEqual({ kind: "complete", reason: "workflow_exhausted" });
  });

  it("permits a configured branch and marks it as off-sequence", () => {
    const decision = resolveRoute({
      workflow,
      visit: visitAt(STATIONS.consultation),
      requestedStationId: STATIONS.radiology,
    });
    expect(decision).toEqual({
      kind: "route",
      toStationId: STATIONS.radiology,
      followedWorkflow: false,
    });
  });

  it("permits returning to a stage that allows repeats", () => {
    // Lab sends the patient back to consultation for results review.
    const decision = resolveRoute({
      workflow,
      visit: visitAt(STATIONS.laboratory),
      requestedStationId: STATIONS.consultation,
    });
    expect(decision).toMatchObject({
      kind: "route",
      toStationId: STATIONS.consultation,
    });
  });

  it("refuses a destination the workflow does not permit", () => {
    // Vitals may only advance to consultation.
    expect(() =>
      resolveRoute({
        workflow,
        visit: visitAt(STATIONS.vitals),
        requestedStationId: STATIONS.pharmacy,
      }),
    ).toThrow(/does not allow returning to this station|does not include/);
  });

  it("refuses a station that is not in the workflow at all", () => {
    expect(() =>
      resolveRoute({
        workflow,
        visit: visitAt(STATIONS.vitals),
        requestedStationId: StationId("st-dialysis"),
      }),
    ).toThrow(/does not include this station/);
  });

  it("lets a supervisor override the workflow explicitly", () => {
    const decision = resolveRoute({
      workflow,
      visit: visitAt(STATIONS.vitals),
      requestedStationId: StationId("st-dialysis"),
      allowOffWorkflow: true,
    });
    expect(decision).toEqual({
      kind: "route",
      toStationId: StationId("st-dialysis"),
      followedWorkflow: false,
    });
  });

  it("refuses to route a visit that is not at a station", () => {
    const deps = makeDeps();
    const visit = Visit.create(
      {
        journeyCode: parseJourneyCode("QM-8F4K"),
        branchId: BRANCH,
        workflowId: workflow.id,
        patient: { name: "Test", hospitalNumber: null, phone: null },
      },
      deps,
    );
    expect(() => resolveRoute({ workflow, visit })).toThrow(
      InvariantViolationError,
    );
  });

  it("tells the UI when completion is a legitimate option", () => {
    // Pharmacy is last: completion is the only move.
    expect(availableDestinations(workflow, STATIONS.pharmacy)).toMatchObject({
      canComplete: true,
    });
    // Reception is followed by a required Vitals stage, so staff must route on.
    expect(availableDestinations(workflow, STATIONS.reception)).toMatchObject({
      canComplete: false,
    });
    // Consultation is followed by an optional Laboratory stage, so a doctor may
    // finish the journey there without sending the patient for tests.
    expect(availableDestinations(workflow, STATIONS.consultation)).toMatchObject(
      { canComplete: true },
    );
  });

  /**
   * The guiding principle from the SAD: adding a station must require no code
   * change. Adding Dialysis to a workflow is pure configuration.
   */
  it("supports a brand-new station with no code change", () => {
    const dialysis = StationId("st-dialysis");
    const extended = {
      ...workflow,
      stages: [
        ...workflow.stages,
        {
          id: WorkflowStageId("stage-dialysis"),
          stationId: dialysis,
          sequence: 7,
          isRequired: false,
          allowSkip: true,
          allowRepeat: true,
          branchesTo: [STATIONS.consultation],
        },
      ],
    };

    expect(validateWorkflow(extended)).toEqual([]);
    expect(
      resolveRoute({
        workflow: extended,
        visit: visitAt(STATIONS.pharmacy),
      }),
    ).toEqual({
      kind: "route",
      toStationId: dialysis,
      followedWorkflow: true,
    });
  });

  it("applies the decision through the aggregate", () => {
    const visit = visitAt(STATIONS.consultation);
    visit.call(DOCTOR);
    visit.startService(DOCTOR);

    const decision = resolveRoute({
      workflow,
      visit,
      requestedStationId: STATIONS.laboratory,
    });
    expect(decision.kind).toBe("route");
    if (decision.kind !== "route") throw new Error("unreachable");

    visit.routeTo(decision.toStationId, ticket(3), {
      actorId: DOCTOR,
      followedWorkflow: decision.followedWorkflow,
    });

    expect(visit.currentStationId).toBe(STATIONS.laboratory);
    const routed = visit.pullEvents().find((e) => e.type === "visit.routed")!;
    expect(routed.payload).toMatchObject({
      fromStationId: STATIONS.consultation,
      toStationId: STATIONS.laboratory,
      followedWorkflow: true,
    });
  });
});
