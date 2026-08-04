import { describe, expect, it } from "vitest";
import {
  hasBlockingProblems,
  problemsFor,
  validateHospitalConfiguration,
  type HospitalConfiguration,
  type StationConfig,
} from "./hospital-config.js";
import { QUEUE_NUMBER_PRESETS } from "../queue/queue-number.js";
import { DEFAULT_TICKET_TEMPLATE } from "../printing/ticket-template.js";
import {
  BranchId,
  HospitalId,
  StationId,
  WorkflowId,
  WorkflowStageId,
} from "../shared/ids.js";

const BRANCH = BranchId("branch-main");
const CONSULT = StationId("st-consultation");
const LAB = StationId("st-laboratory");
const RECEPTION = StationId("st-reception");

function station(
  id: StationId,
  name: string,
  code: string,
  overrides: Partial<StationConfig> = {},
): StationConfig {
  return {
    id,
    name,
    code,
    room: "Room 1",
    staffing: 1,
    serviceEstimateMillis: 10 * 60_000,
    sla: { targetWaitMillis: 20 * 60_000, saturationPoint: 10 },
    queueNumber: QUEUE_NUMBER_PRESETS.departmentPrefix(),
    isPublic: true,
    enabled: true,
    ...overrides,
  };
}

function baseConfig(
  overrides: Partial<HospitalConfiguration> = {},
): HospitalConfiguration {
  return {
    profile: {
      id: HospitalId("h1"),
      name: "Test Hospital",
      code: "TH",
      timezone: "Africa/Lagos",
      supportPhone: null,
      brandColor: "#003ec7",
    },
    branches: [
      { id: BRANCH, name: "Main", code: "MAIN", isDefault: true },
    ],
    stations: [
      station(RECEPTION, "Reception", "REC", { isPublic: false }),
      station(CONSULT, "Consultation", "OPD"),
      station(LAB, "Laboratory", "LAB"),
    ],
    workflows: [
      {
        id: WorkflowId("wf"),
        branchId: BRANCH,
        name: "Outpatient",
        isDefault: true,
        stages: [
          {
            id: WorkflowStageId("s1"),
            stationId: RECEPTION,
            sequence: 1,
            isRequired: true,
            allowSkip: false,
            allowRepeat: false,
            branchesTo: [],
          },
          {
            id: WorkflowStageId("s2"),
            stationId: CONSULT,
            sequence: 2,
            isRequired: true,
            allowSkip: false,
            allowRepeat: false,
            branchesTo: [],
          },
        ],
      },
    ],
    displayBoards: [
      {
        id: "board-main",
        name: "Main",
        stationIds: [CONSULT],
        waitingToShow: 4,
        namePolicy: "ticket_only",
        showEstimatedWait: true,
        showRoom: true,
      },
    ],
    ticketTemplates: [DEFAULT_TICKET_TEMPLATE],
    defaults: {
      namePolicy: "ticket_only",
      ticketTemplateId: DEFAULT_TICKET_TEMPLATE.id,
    },
    ...overrides,
  };
}

describe("hospital configuration validation", () => {
  it("accepts a well-formed configuration", () => {
    expect(validateHospitalConfiguration(baseConfig())).toEqual([]);
  });

  it("requires a hospital name and a valid brand colour", () => {
    const problems = validateHospitalConfiguration(
      baseConfig({
        profile: { ...baseConfig().profile, name: "  ", brandColor: "blue" },
      }),
    );
    expect(problems.map((p) => p.path)).toContain("profile.name");
    expect(problems.map((p) => p.path)).toContain("profile.brandColor");
    expect(hasBlockingProblems(problems)).toBe(true);
  });

  it("requires at least one branch and one workflow", () => {
    expect(
      validateHospitalConfiguration(baseConfig({ branches: [] })).map((p) => p.path),
    ).toContain("branches");
    expect(
      validateHospitalConfiguration(baseConfig({ workflows: [] })).map((p) => p.path),
    ).toContain("workflows");
  });

  it("rejects a station whose queue-number template is unusable", () => {
    const problems = validateHospitalConfiguration(
      baseConfig({
        stations: [
          station(CONSULT, "Consultation", "OPD", {
            // No {n} or {journey}: every patient would get the same ticket.
            queueNumber: { template: "OPD", reset: "daily" },
          }),
        ],
      }),
    );
    expect(problems.some((p) => p.path.endsWith("queueNumber"))).toBe(true);
    expect(hasBlockingProblems(problems)).toBe(true);
  });

  it("rejects nonsensical staffing and SLA values", () => {
    const problems = validateHospitalConfiguration(
      baseConfig({
        stations: [
          station(CONSULT, "Consultation", "OPD", {
            staffing: 0,
            serviceEstimateMillis: 0,
            sla: { targetWaitMillis: 0, saturationPoint: 0 },
          }),
        ],
      }),
    );
    const paths = problems.map((p) => p.path);
    expect(paths).toContain(`stations.${CONSULT}.staffing`);
    expect(paths).toContain(`stations.${CONSULT}.serviceEstimateMillis`);
    expect(paths.filter((p) => p === `stations.${CONSULT}.sla`).length).toBe(2);
  });

  /**
   * The privacy rule that matters most in configuration: an internal queue must
   * never be projectable onto a waiting-room screen.
   */
  it("refuses to put a non-public station on a display board", () => {
    const problems = validateHospitalConfiguration(
      baseConfig({
        displayBoards: [
          {
            id: "board-main",
            name: "Main",
            stationIds: [RECEPTION],
            waitingToShow: 4,
            namePolicy: "ticket_only",
            showEstimatedWait: true,
            showRoom: true,
          },
        ],
      }),
    );
    expect(problems.some((p) => /not a public station/.test(p.message))).toBe(true);
    expect(hasBlockingProblems(problems)).toBe(true);
  });

  it("rejects a board that shows a station which no longer exists", () => {
    const problems = validateHospitalConfiguration(
      baseConfig({
        displayBoards: [
          {
            id: "board-main",
            name: "Main",
            stationIds: [StationId("st-deleted")],
            waitingToShow: 4,
            namePolicy: "ticket_only",
            showEstimatedWait: true,
            showRoom: true,
          },
        ],
      }),
    );
    expect(problems.some((p) => /no longer exists/.test(p.message))).toBe(true);
  });

  it("rejects a workflow routing through a deleted station", () => {
    const config = baseConfig();
    const problems = validateHospitalConfiguration({
      ...config,
      stations: config.stations.filter((s) => s.id !== CONSULT),
    });
    expect(problems.some((p) => /no longer exists/.test(p.message))).toBe(true);
  });

  it("warns without blocking on a missing room", () => {
    const problems = validateHospitalConfiguration(
      baseConfig({
        stations: [station(CONSULT, "Consultation", "OPD", { room: null })],
      }),
    );
    const roomProblem = problems.find((p) => p.path.endsWith(".room"))!;
    expect(roomProblem.severity).toBe("warning");
    // A warning must never stop an administrator saving, or they will type
    // junk into the field to get past it.
    expect(hasBlockingProblems(problems.filter((p) => p.path.endsWith(".room")))).toBe(
      false,
    );
  });

  it("warns on duplicate station codes because tickets become ambiguous", () => {
    const problems = validateHospitalConfiguration(
      baseConfig({
        stations: [
          station(CONSULT, "Consultation", "LAB"),
          station(LAB, "Laboratory", "LAB"),
        ],
      }),
    );
    const dup = problems.find((p) => /also used by/.test(p.message))!;
    expect(dup.severity).toBe("warning");
  });

  it("locates problems by path so the portal can jump to the field", () => {
    const problems = validateHospitalConfiguration(
      baseConfig({
        profile: { ...baseConfig().profile, name: "" },
      }),
    );
    expect(problemsFor(problems, "profile")).toHaveLength(1);
    expect(problemsFor(problems, "stations")).toHaveLength(0);
  });
});
