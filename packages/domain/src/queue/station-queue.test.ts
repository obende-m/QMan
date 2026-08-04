import { describe, expect, it } from "vitest";
import {
  buildWorklist,
  estimateWaitMillis,
  orderQueue,
  positionOf,
  type QueueItem,
} from "./station-queue.js";
import type { QueueEntry, QueueEntryStatus } from "../visit/queue-entry.js";
import type { Priority } from "../visit/priority.js";
import { QueueEntryId, VisitId } from "../shared/ids.js";
import { parseJourneyCode } from "../journey/journey-code.js";
import { STATIONS } from "../testing/fixtures.js";

const BASE = new Date("2026-01-01T08:00:00.000Z");

function at(minutes: number): Date {
  return new Date(BASE.getTime() + minutes * 60_000);
}

function item(
  name: string,
  options: {
    priority?: Priority;
    queuedAtMinute?: number;
    status?: QueueEntryStatus;
    skipped?: boolean;
    queueNumber?: number;
    startedAtMinute?: number;
    completedAtMinute?: number;
  } = {},
): QueueItem {
  const entry: QueueEntry = {
    id: QueueEntryId(`qe-${name}`),
    stationId: STATIONS.consultation,
    queueNumber: options.queueNumber ?? 1,
    queueLabel: `C-${String(options.queueNumber ?? 1).padStart(3, "0")}`,
    queuePeriod: "2026-03-09",
    status: options.status ?? "waiting",
    assignedUserId: null,
    queuedAt: at(options.queuedAtMinute ?? 0),
    calledAt: null,
    startedAt:
      options.startedAtMinute === undefined ? null : at(options.startedAtMinute),
    completedAt:
      options.completedAtMinute === undefined
        ? null
        : at(options.completedAtMinute),
    callAttempts: 0,
    skipped: options.skipped ?? false,
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

describe("queue ordering", () => {
  it("serves in arrival order when priorities match", () => {
    const ordered = orderQueue([
      item("Chidi", { queuedAtMinute: 20 }),
      item("Amara", { queuedAtMinute: 5 }),
      item("Bola", { queuedAtMinute: 12 }),
    ]);
    expect(ordered.map((i) => i.patientName)).toEqual([
      "Amara",
      "Bola",
      "Chidi",
    ]);
  });

  it("puts an emergency ahead of everyone regardless of arrival", () => {
    const ordered = orderQueue([
      item("Amara", { queuedAtMinute: 5 }),
      item("Bola", { queuedAtMinute: 12 }),
      item("Emergency", { queuedAtMinute: 30, priority: "emergency" }),
    ]);
    expect(ordered[0]!.patientName).toBe("Emergency");
  });

  it("never lets a VIP outrank clinical urgency", () => {
    // The deliberate ranking decision: a commercial courtesy tier sits below
    // both Emergency and High, above Normal only.
    const ordered = orderQueue([
      item("Vip", { queuedAtMinute: 1, priority: "vip" }),
      item("Urgent", { queuedAtMinute: 40, priority: "high" }),
      item("Critical", { queuedAtMinute: 50, priority: "emergency" }),
      item("Regular", { queuedAtMinute: 0, priority: "normal" }),
    ]);
    expect(ordered.map((i) => i.patientName)).toEqual([
      "Critical",
      "Urgent",
      "Vip",
      "Regular",
    ]);
  });

  it("yields a skipped patient to peers but does not send them to the back", () => {
    const ordered = orderQueue([
      item("Skipped", { queuedAtMinute: 0, skipped: true }),
      item("Waited", { queuedAtMinute: 10 }),
      item("Latecomer", { queuedAtMinute: 90 }),
    ]);
    // Skipped loses to those already present, but still beats a later arrival.
    expect(ordered.map((i) => i.patientName)).toEqual([
      "Waited",
      "Latecomer",
      "Skipped",
    ]);
  });

  it("orders deterministically when two patients queue in the same instant", () => {
    const a = item("A", { queuedAtMinute: 5, queueNumber: 8 });
    const b = item("B", { queuedAtMinute: 5, queueNumber: 3 });
    expect(orderQueue([a, b]).map((i) => i.patientName)).toEqual(["B", "A"]);
    expect(orderQueue([b, a]).map((i) => i.patientName)).toEqual(["B", "A"]);
  });

  it("reports a patient's position, or null once they are no longer waiting", () => {
    const items = [
      item("Amara", { queuedAtMinute: 5 }),
      item("Bola", { queuedAtMinute: 12 }),
    ];
    const ordered = orderQueue(items);
    expect(positionOf(VisitId("visit-Bola"), ordered)).toBe(2);
    expect(positionOf(VisitId("visit-Nobody"), ordered)).toBeNull();
  });
});

describe("station worklist", () => {
  it("separates the current patient, the queue, skips and completions", () => {
    const worklist = buildWorklist(STATIONS.consultation, [
      item("BeingSeen", { status: "in_progress" }),
      item("Amara", { queuedAtMinute: 5 }),
      item("Stepped Out", { queuedAtMinute: 2, skipped: true }),
      item("Done", {
        status: "completed",
        queuedAtMinute: 0,
        startedAtMinute: 10,
        completedAtMinute: 25,
      }),
      item("Gone", { status: "cancelled" }),
    ]);

    expect(worklist.current?.patientName).toBe("BeingSeen");
    expect(worklist.waiting.map((i) => i.patientName)).toEqual([
      "Amara",
      "Stepped Out",
    ]);
    // A skipped patient appears in both lists: still queued, and flagged for
    // the station's attention.
    expect(worklist.skipped.map((i) => i.patientName)).toEqual(["Stepped Out"]);
    expect(worklist.counts).toMatchObject({
      waiting: 2,
      skipped: 1,
      completedToday: 1,
      emergencies: 0,
    });
    // Cancelled visits belong to no list.
    expect(worklist.completedToday).toHaveLength(1);
  });

  it("computes today's average wait and service time from completed work", () => {
    const worklist = buildWorklist(STATIONS.consultation, [
      item("One", {
        status: "completed",
        queuedAtMinute: 0,
        startedAtMinute: 10,
        completedAtMinute: 20,
      }),
      item("Two", {
        status: "completed",
        queuedAtMinute: 0,
        startedAtMinute: 20,
        completedAtMinute: 50,
      }),
    ]);
    expect(worklist.averageWaitMillis).toBe(15 * 60_000);
    expect(worklist.averageServiceMillis).toBe(20 * 60_000);
  });

  it("reports null averages before any patient has been served", () => {
    const worklist = buildWorklist(STATIONS.consultation, [item("Waiting")]);
    expect(worklist.averageWaitMillis).toBeNull();
    expect(worklist.averageServiceMillis).toBeNull();
  });

  it("counts emergencies so a station can see them at a glance", () => {
    const worklist = buildWorklist(STATIONS.consultation, [
      item("A", { priority: "emergency" }),
      item("B", { priority: "emergency" }),
      item("C"),
    ]);
    expect(worklist.counts.emergencies).toBe(2);
  });
});

describe("wait estimation", () => {
  it("is zero for the patient at the front", () => {
    expect(
      estimateWaitMillis({
        position: 1,
        serversAvailable: 1,
        observedServiceMillis: 10 * 60_000,
        configuredServiceMillis: 15 * 60_000,
      }),
    ).toBe(0);
  });

  it("prefers observed service time over the configured estimate", () => {
    const observed = estimateWaitMillis({
      position: 5,
      serversAvailable: 1,
      observedServiceMillis: 10 * 60_000,
      configuredServiceMillis: 30 * 60_000,
    });
    // 4 ahead x 10 min, padded 15%.
    expect(observed).toBe(Math.round(4 * 10 * 60_000 * 1.15));
  });

  it("falls back to the configured estimate before data exists", () => {
    expect(
      estimateWaitMillis({
        position: 3,
        serversAvailable: 1,
        observedServiceMillis: null,
        configuredServiceMillis: 20 * 60_000,
      }),
    ).toBe(Math.round(2 * 20 * 60_000 * 1.15));
  });

  it("divides the wait across the staff actually on the station", () => {
    const oneDoctor = estimateWaitMillis({
      position: 9,
      serversAvailable: 1,
      observedServiceMillis: 10 * 60_000,
      configuredServiceMillis: 10 * 60_000,
    });
    const fourDoctors = estimateWaitMillis({
      position: 9,
      serversAvailable: 4,
      observedServiceMillis: 10 * 60_000,
      configuredServiceMillis: 10 * 60_000,
    });
    expect(fourDoctors).toBe(Math.round(oneDoctor / 4));
  });

  it("never divides by zero when a station is unstaffed", () => {
    expect(
      estimateWaitMillis({
        position: 4,
        serversAvailable: 0,
        observedServiceMillis: 10 * 60_000,
        configuredServiceMillis: 10 * 60_000,
      }),
    ).toBe(Math.round(3 * 10 * 60_000 * 1.15));
  });

  it("errs on the side of over-estimating", () => {
    // Patients tolerate being seen early far better than being seen late.
    const raw = 4 * 10 * 60_000;
    expect(
      estimateWaitMillis({
        position: 5,
        serversAvailable: 1,
        observedServiceMillis: 10 * 60_000,
        configuredServiceMillis: 10 * 60_000,
      }),
    ).toBeGreaterThan(raw);
  });
});
