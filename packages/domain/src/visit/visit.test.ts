import { beforeEach, describe, expect, it } from "vitest";
import { Visit } from "./visit.js";
import { parseJourneyCode } from "../journey/journey-code.js";
import { serviceMillis, waitedMillis } from "./queue-entry.js";
import {
  IllegalTransitionError,
  InvariantViolationError,
  ValidationError,
} from "../shared/errors.js";
import { UserId, WorkflowId } from "../shared/ids.js";
import { BRANCH, STATIONS, makeDeps, ticket } from "../testing/fixtures.js";
import type { VisitEventType } from "../events/visit-events.js";
import type { FixedClock } from "../shared/clock.js";

const RECEPTIONIST = UserId("user-reception");
const DOCTOR = UserId("user-doctor");
const LAB_SCIENTIST = UserId("user-lab");

function newVisit(deps: ReturnType<typeof makeDeps>): Visit {
  return Visit.create(
    {
      journeyCode: parseJourneyCode("QM-8F4K"),
      branchId: BRANCH,
      workflowId: WorkflowId("wf-opd"),
      patient: {
        name: "Amara Okafor",
        hospitalNumber: "HN-40128",
        phone: null,
      },
    },
    deps,
    { actorId: RECEPTIONIST },
  );
}

describe("Visit aggregate", () => {
  let deps: ReturnType<typeof makeDeps>;
  let clock: FixedClock;

  beforeEach(() => {
    deps = makeDeps();
    clock = deps.clock;
  });

  it("is created in the Created state and records the fact", () => {
    const visit = newVisit(deps);
    expect(visit.status).toBe("created");
    expect(visit.currentStationId).toBeNull();

    const events = visit.pullEvents();
    expect(events.map((e) => e.type)).toEqual(["visit.created"]);
    expect(events[0]!.payload).toMatchObject({
      journeyCode: "QM-8F4K",
      priority: "normal",
    });
  });

  it("keeps the patient's identity out of the event it records", () => {
    const visit = newVisit(deps);
    const [created] = visit.pullEvents();
    const text = JSON.stringify(created!.payload);
    expect(text).not.toContain("Amara");
    expect(text).not.toContain("HN-40128");
  });

  it("refuses a priority outside the recognised set", () => {
    expect(() =>
      Visit.create(
        {
          journeyCode: parseJourneyCode("QM-8F4K"),
          branchId: BRANCH,
          workflowId: WorkflowId("wf-opd"),
          patient: { name: "Amara Okafor", hospitalNumber: null, phone: null },
          priority: "urgent" as never,
        },
        deps,
      ),
    ).toThrow(ValidationError);
  });

  it("requires a patient name", () => {
    expect(() =>
      Visit.create(
        {
          journeyCode: parseJourneyCode("QM-8F4K"),
          branchId: BRANCH,
          workflowId: WorkflowId("wf-opd"),
          patient: { name: "   ", hospitalNumber: null, phone: null },
        },
        deps,
      ),
    ).toThrow(ValidationError);
  });

  it("hands out events once and then clears them", () => {
    const visit = newVisit(deps);
    expect(visit.hasPendingEvents).toBe(true);
    expect(visit.pullEvents()).toHaveLength(1);
    expect(visit.pullEvents()).toHaveLength(0);
    expect(visit.hasPendingEvents).toBe(false);
  });

  it("opens a queue entry when enqueued", () => {
    const visit = newVisit(deps);
    visit.pullEvents();

    const entry = visit.enqueue(STATIONS.reception, ticket(1), {
      actorId: RECEPTIONIST,
    });

    expect(visit.status).toBe("queued");
    expect(visit.currentStationId).toBe(STATIONS.reception);
    expect(entry.status).toBe("waiting");
    expect(entry.queueNumber).toBe(1);
    expect(visit.pullEvents().map((e) => e.type)).toEqual(["visit.queued"]);
  });

  it("rejects a nonsensical queue number", () => {
    const visit = newVisit(deps);
    expect(() => visit.enqueue(STATIONS.reception, ticket(0))).toThrow(ValidationError);
    expect(() => visit.enqueue(STATIONS.reception, ticket(1.5))).toThrow(
      ValidationError,
    );
  });

  it("measures the wait between queueing and service starting", () => {
    const visit = newVisit(deps);
    visit.enqueue(STATIONS.reception, ticket(1));
    visit.pullEvents();

    clock.advanceMinutes(12);
    visit.call(RECEPTIONIST);
    clock.advanceMinutes(3);
    visit.startService(RECEPTIONIST);

    const entry = visit.currentEntry!;
    expect(waitedMillis(entry)).toBe(15 * 60_000);
    const started = visit
      .pullEvents()
      .find((e) => e.type === "visit.service_started")!;
    expect(started.payload).toMatchObject({ waitedMillis: 15 * 60_000 });
  });

  it("counts recalls without restarting the wait clock", () => {
    const visit = newVisit(deps);
    visit.enqueue(STATIONS.reception, ticket(1));
    clock.advanceMinutes(5);
    visit.call(RECEPTIONIST);
    const firstCall = visit.currentEntry!.calledAt;

    clock.advanceMinutes(2);
    visit.recall(RECEPTIONIST);

    expect(visit.status).toBe("called");
    expect(visit.currentEntry!.callAttempts).toBe(2);
    // calledAt marks the first announcement, so "how long since first called"
    // stays meaningful across recalls.
    expect(visit.currentEntry!.calledAt).toEqual(firstCall);
  });

  it("does not turn a second call into a recall", () => {
    const visit = newVisit(deps);
    visit.enqueue(STATIONS.reception, ticket(1));
    visit.call(RECEPTIONIST);
    expect(() => visit.call(RECEPTIONIST)).toThrow(InvariantViolationError);
    expect(visit.currentEntry!.callAttempts).toBe(1);
  });

  it("refuses to recall a patient who was never called", () => {
    const visit = newVisit(deps);
    visit.enqueue(STATIONS.reception, ticket(1));
    expect(() => visit.recall(RECEPTIONIST)).toThrow(InvariantViolationError);
  });

  it("keeps a skipped patient in the queue rather than discarding them", () => {
    const visit = newVisit(deps);
    visit.enqueue(STATIONS.consultation, ticket(7));
    visit.call(DOCTOR);
    visit.pullEvents();

    visit.skip({ actorId: DOCTOR, reason: "Not present" });

    expect(visit.status).toBe("queued");
    const entry = visit.currentEntry!;
    expect(entry.status).toBe("waiting");
    expect(entry.skipped).toBe(true);
    expect(entry.skipReason).toBe("Not present");
    // Still the same entry — they keep their place and their arrival time.
    expect(visit.queueEntries).toHaveLength(1);
    expect(visit.pullEvents().map((e) => e.type)).toEqual(["visit.skipped"]);
  });

  it("refuses to skip a patient who was never called", () => {
    const visit = newVisit(deps);
    visit.enqueue(STATIONS.consultation, ticket(7));
    expect(() => visit.skip()).toThrow(IllegalTransitionError);
  });

  it("routes atomically, never leaving the visit between queues", () => {
    const visit = newVisit(deps);
    visit.enqueue(STATIONS.vitals, ticket(3));
    visit.call(DOCTOR);
    visit.startService(DOCTOR);
    clock.advanceMinutes(6);
    visit.pullEvents();

    visit.routeTo(STATIONS.consultation, ticket(4), { actorId: DOCTOR });

    expect(visit.status).toBe("queued");
    expect(visit.currentStationId).toBe(STATIONS.consultation);
    expect(visit.queueEntries).toHaveLength(2);
    expect(visit.queueEntries[0]!.status).toBe("completed");
    expect(serviceMillis(visit.queueEntries[0]!)).toBe(6 * 60_000);

    // One action, three facts on the audit trail, in causal order.
    expect(visit.pullEvents().map((e) => e.type)).toEqual([
      "visit.stage_completed",
      "visit.routed",
      "visit.queued",
    ]);
  });

  it("refuses to route a visit to where it already is", () => {
    const visit = newVisit(deps);
    visit.enqueue(STATIONS.vitals, ticket(1));
    expect(() => visit.routeTo(STATIONS.vitals, ticket(2))).toThrow(
      InvariantViolationError,
    );
  });

  it("refuses to act on a visit that is in no queue", () => {
    const visit = newVisit(deps);
    expect(() => visit.call(DOCTOR)).toThrow(IllegalTransitionError);
  });

  it("closes the open queue entry when the journey completes", () => {
    const visit = newVisit(deps);
    visit.enqueue(STATIONS.pharmacy, ticket(2));
    visit.call(DOCTOR);
    visit.startService(DOCTOR);
    clock.advanceMinutes(4);
    visit.pullEvents();

    visit.complete({ actorId: DOCTOR });

    expect(visit.status).toBe("completed");
    expect(visit.currentEntry).toBeUndefined();
    expect(visit.queueEntries[0]!.status).toBe("completed");
    expect(visit.pullEvents().map((e) => e.type)).toEqual([
      "visit.stage_completed",
      "visit.completed",
    ]);
  });

  it("seals the record on close and refuses all further action", () => {
    const visit = newVisit(deps);
    visit.enqueue(STATIONS.reception, ticket(1));
    visit.call(RECEPTIONIST);
    visit.complete();
    visit.close();
    visit.pullEvents();

    expect(visit.status).toBe("closed");
    expect(() => visit.call(DOCTOR)).toThrow(IllegalTransitionError);
    expect(() => visit.cancel()).toThrow(IllegalTransitionError);
    expect(() => visit.changePriority("emergency")).toThrow(
      InvariantViolationError,
    );
  });

  it("records a priority change but ignores a no-op change", () => {
    const visit = newVisit(deps);
    visit.pullEvents();

    visit.changePriority("normal");
    expect(visit.pullEvents()).toHaveLength(0);

    visit.changePriority("emergency", { actorId: DOCTOR, reason: "Collapsed" });
    expect(visit.priority).toBe("emergency");
    const [event] = visit.pullEvents();
    expect(event!.type).toBe("visit.priority_changed");
    expect(event!.payload).toMatchObject({
      from: "normal",
      to: "emergency",
      reason: "Collapsed",
    });
  });

  it("cancels an in-flight visit and releases its queue entry", () => {
    const visit = newVisit(deps);
    visit.enqueue(STATIONS.vitals, ticket(5));
    visit.pullEvents();

    visit.cancel({ actorId: RECEPTIONIST, reason: "Patient left" });

    expect(visit.status).toBe("cancelled");
    expect(visit.queueEntries[0]!.status).toBe("cancelled");
    expect(visit.currentEntry).toBeUndefined();
    expect(visit.pullEvents().map((e) => e.type)).toEqual(["visit.cancelled"]);
  });

  /**
   * The full journey from the SAD, end to end:
   * Reception â†’ Vitals â†’ Consultation â†’ Laboratory â†’ Consultation â†’ Completed.
   */
  it("carries a patient through a complete clinical journey with a lab detour", () => {
    const visit = newVisit(deps);
    const seen: VisitEventType[] = [];
    const drain = () => seen.push(...visit.pullEvents().map((e) => e.type));

    visit.enqueue(STATIONS.reception, ticket(1), { actorId: RECEPTIONIST });
    visit.call(RECEPTIONIST);
    visit.startService(RECEPTIONIST);
    clock.advanceMinutes(3);
    visit.routeTo(STATIONS.vitals, ticket(1), { actorId: RECEPTIONIST });
    drain();

    clock.advanceMinutes(8);
    visit.call(DOCTOR);
    visit.startService(DOCTOR);
    clock.advanceMinutes(4);
    visit.routeTo(STATIONS.consultation, ticket(2), { actorId: DOCTOR });
    drain();

    clock.advanceMinutes(20);
    visit.call(DOCTOR);
    visit.startService(DOCTOR);
    clock.advanceMinutes(11);
    visit.routeTo(STATIONS.laboratory, ticket(5), { actorId: DOCTOR });
    drain();

    clock.advanceMinutes(35);
    visit.call(LAB_SCIENTIST);
    visit.startService(LAB_SCIENTIST);
    clock.advanceMinutes(9);
    // Back to the doctor to review results — the repeat leg.
    visit.routeTo(STATIONS.consultation, ticket(9), {
      actorId: LAB_SCIENTIST,
      followedWorkflow: false,
    });
    drain();

    clock.advanceMinutes(14);
    visit.call(DOCTOR);
    visit.startService(DOCTOR);
    clock.advanceMinutes(6);
    visit.complete({ actorId: DOCTOR });
    drain();

    expect(visit.status).toBe("completed");
    expect(visit.queueEntries).toHaveLength(5);
    expect(visit.queueEntries.every((e) => e.status === "completed")).toBe(true);

    // Consultation was visited twice but counts once as a distinct station.
    expect(visit.stationsVisited).toBe(4);

    // Every stage produced a completion, and the journey produced exactly one
    // completion event.
    expect(seen.filter((t) => t === "visit.stage_completed")).toHaveLength(5);
    expect(seen.filter((t) => t === "visit.queued")).toHaveLength(5);
    expect(seen.filter((t) => t === "visit.routed")).toHaveLength(4);
    expect(seen.filter((t) => t === "visit.completed")).toHaveLength(1);

    // 3+8+4+20+11+35+9+14+6 = 110 minutes door to door.
    const total = visit.completedAt!.getTime() - visit.createdAt.getTime();
    expect(total).toBe(110 * 60_000);
  });

  it("round-trips through storage without losing state", () => {
    const visit = newVisit(deps);
    visit.enqueue(STATIONS.consultation, ticket(12));
    visit.call(DOCTOR);
    visit.pullEvents();

    const snapshot = structuredClone(visit.toState());
    const restored = Visit.rehydrate(snapshot, deps);

    expect(restored.status).toBe("called");
    expect(restored.journeyCode).toBe("QM-8F4K");
    expect(restored.currentStationId).toBe(STATIONS.consultation);
    expect(restored.hasPendingEvents).toBe(false);

    // And it carries on from exactly where it left off.
    restored.startService(DOCTOR);
    expect(restored.status).toBe("in_progress");
  });
});
