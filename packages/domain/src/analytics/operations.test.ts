import { describe, expect, it } from "vitest";
import {
  assessStation,
  clinicPulse,
  longestWaitingPatient,
  rankBottlenecks,
  staffWorkloads,
  type StationSla,
} from "./operations.js";
import { buildWorklist, type QueueItem } from "../queue/station-queue.js";
import { parseJourneyCode } from "../journey/journey-code.js";
import { QueueEntryId, StationId, UserId, VisitId } from "../shared/ids.js";
import type { QueueEntry, QueueEntryStatus } from "../visit/queue-entry.js";
import type { Priority } from "../visit/priority.js";

const NOW = new Date("2026-03-09T10:00:00.000Z");
const CONSULT = StationId("st-consultation");
const LAB = StationId("st-laboratory");

const SLA: StationSla = {
  targetWaitMillis: 30 * 60_000,
  saturationPoint: 10,
};

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function item(
  name: string,
  options: {
    stationId?: StationId;
    waitedMinutes?: number;
    status?: QueueEntryStatus;
    priority?: Priority;
    assignedUserId?: UserId;
    serviceMinutes?: number;
  } = {},
): QueueItem {
  const queuedAt = minutesAgo(options.waitedMinutes ?? 0);
  const completed = options.status === "completed";
  const entry: QueueEntry = {
    id: QueueEntryId(`qe-${name}`),
    stationId: options.stationId ?? CONSULT,
    queueNumber: 1,
    queueLabel: `A-001`,
    queuePeriod: "2026-03-09",
    status: options.status ?? "waiting",
    assignedUserId: options.assignedUserId ?? null,
    queuedAt,
    calledAt: null,
    startedAt: completed ? minutesAgo((options.waitedMinutes ?? 0) - 10) : null,
    completedAt: completed
      ? minutesAgo(
          (options.waitedMinutes ?? 0) - 10 - (options.serviceMinutes ?? 5),
        )
      : null,
    callAttempts: 0,
    skipped: false,
    skipReason: null,
  };
  return {
    visitId: VisitId(`visit-${name}`),
    journeyCode: parseJourneyCode("QM-8F4K"),
    patientName: name,
    priority: options.priority ?? "normal",
    entry,
  };
}

describe("station health", () => {
  it("is healthy when nobody has waited near the target", () => {
    const worklist = buildWorklist(CONSULT, [item("A", { waitedMinutes: 5 })]);
    expect(assessStation(worklist, SLA, NOW).status).toBe("healthy");
  });

  it("warns before the target is missed, not after", () => {
    // 75% of a 30-minute target.
    const worklist = buildWorklist(CONSULT, [item("A", { waitedMinutes: 23 })]);
    expect(assessStation(worklist, SLA, NOW).status).toBe("at_risk");
  });

  it("reports a breach once the target is passed", () => {
    const worklist = buildWorklist(CONSULT, [item("A", { waitedMinutes: 31 })]);
    expect(assessStation(worklist, SLA, NOW).status).toBe("breached");
  });

  /**
   * The reason status keys off the longest wait rather than the mean: an
   * average hides the one patient who is about to complain.
   */
  it("judges by the longest wait, not the average", () => {
    const worklist = buildWorklist(CONSULT, [
      item("Fine1", { waitedMinutes: 2 }),
      item("Fine2", { waitedMinutes: 3 }),
      item("Fine3", { waitedMinutes: 2 }),
      item("Forgotten", { waitedMinutes: 48 }),
    ]);
    const health = assessStation(worklist, SLA, NOW);
    // Mean is ~14 minutes, comfortably inside target. Status must still breach.
    expect(health.status).toBe("breached");
    expect(health.longestWaitMillis).toBe(48 * 60_000);
  });

  it("reports load as a ratio of the station's own saturation point", () => {
    const worklist = buildWorklist(
      CONSULT,
      Array.from({ length: 5 }, (_, i) => item(`P${i}`)),
    );
    expect(assessStation(worklist, SLA, NOW).loadRatio).toBe(0.5);
  });

  it("never reports load above 1", () => {
    const worklist = buildWorklist(
      CONSULT,
      Array.from({ length: 40 }, (_, i) => item(`P${i}`)),
    );
    expect(assessStation(worklist, SLA, NOW).loadRatio).toBe(1);
  });

  it("counts an empty station as healthy rather than unknown", () => {
    const health = assessStation(buildWorklist(CONSULT, []), SLA, NOW);
    expect(health.status).toBe("healthy");
    expect(health.longestWaitMillis).toBe(0);
    expect(health.averageWaitMillis).toBeNull();
  });
});

describe("bottlenecks", () => {
  it("lists only stations needing attention, worst first", () => {
    const healthy = assessStation(
      buildWorklist(CONSULT, [item("A", { waitedMinutes: 1 })]),
      SLA,
      NOW,
    );
    const atRisk = assessStation(
      buildWorklist(LAB, [item("B", { waitedMinutes: 24 })]),
      SLA,
      NOW,
    );
    const breached = assessStation(
      buildWorklist(StationId("st-x"), [item("C", { waitedMinutes: 40 })]),
      SLA,
      NOW,
    );

    const ranked = rankBottlenecks([healthy, atRisk, breached]);
    expect(ranked.map((h) => h.status)).toEqual(["breached", "at_risk"]);
  });

  it("is empty when the hospital is running well", () => {
    const healthy = assessStation(
      buildWorklist(CONSULT, [item("A", { waitedMinutes: 1 })]),
      SLA,
      NOW,
    );
    expect(rankBottlenecks([healthy])).toEqual([]);
  });
});

describe("longest waiting patient", () => {
  it("names the individual, across every station", () => {
    const worklists = [
      buildWorklist(CONSULT, [item("Near", { waitedMinutes: 12 })]),
      buildWorklist(LAB, [
        item("Grace", { stationId: LAB, waitedMinutes: 51 }),
        item("Other", { stationId: LAB, waitedMinutes: 4 }),
      ]),
    ];

    const worst = longestWaitingPatient(worklists, NOW)!;
    expect(worst.item.patientName).toBe("Grace");
    expect(worst.stationId).toBe(LAB);
    expect(worst.waitedMillis).toBe(51 * 60_000);
  });

  it("returns null when nobody is waiting", () => {
    expect(longestWaitingPatient([buildWorklist(CONSULT, [])], NOW)).toBeNull();
  });
});

describe("staff workload", () => {
  it("counts completions and flags who is currently busy", () => {
    const doctor = UserId("user-doctor");
    const nurse = UserId("user-nurse");

    const worklists = [
      buildWorklist(CONSULT, [
        item("InProgress", {
          status: "in_progress",
          assignedUserId: doctor,
        }),
        item("Done1", {
          status: "completed",
          assignedUserId: doctor,
          waitedMinutes: 60,
          serviceMinutes: 10,
        }),
        item("Done2", {
          status: "completed",
          assignedUserId: doctor,
          waitedMinutes: 90,
          serviceMinutes: 20,
        }),
        item("Done3", {
          status: "completed",
          assignedUserId: nurse,
          waitedMinutes: 45,
          serviceMinutes: 5,
        }),
      ]),
    ];

    const workloads = staffWorkloads(worklists);
    expect(workloads[0]!.userId).toBe(doctor);
    expect(workloads[0]!.completed).toBe(2);
    expect(workloads[0]!.active).toBe(true);
    expect(workloads[0]!.averageServiceMillis).toBe(15 * 60_000);

    expect(workloads[1]!.userId).toBe(nurse);
    expect(workloads[1]!.active).toBe(false);
  });

  it("ignores queue entries with nobody assigned", () => {
    const worklists = [
      buildWorklist(CONSULT, [item("Unassigned", { status: "completed" })]),
    ];
    expect(staffWorkloads(worklists)).toEqual([]);
  });
});

describe("clinic pulse", () => {
  it("aggregates the headline numbers from the same worklists", () => {
    const consult = buildWorklist(CONSULT, [
      item("W1", { waitedMinutes: 5 }),
      item("W2", { waitedMinutes: 40 }),
      item("Serving", { status: "in_progress" }),
      item("Done", { status: "completed", waitedMinutes: 60 }),
    ]);
    const lab = buildWorklist(LAB, [
      item("W3", { stationId: LAB, waitedMinutes: 2 }),
    ]);

    const healths = [
      assessStation(consult, SLA, NOW),
      assessStation(lab, SLA, NOW),
    ];
    const pulse = clinicPulse(healths, [consult, lab]);

    expect(pulse.waiting).toBe(3);
    expect(pulse.beingServed).toBe(1);
    expect(pulse.completedToday).toBe(1);
    expect(pulse.stationsBreached).toBe(1);
    expect(pulse.stationsAtRisk).toBe(0);
  });
});
