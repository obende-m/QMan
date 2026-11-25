/**
 * The serialisation contract.
 *
 * One definition, so a field added to the aggregate cannot be written by the
 * server and silently dropped by the browser. The round trip is the test: a
 * visit that survives it renders the same projections on either side.
 */
import { describe, expect, it } from "vitest";
import { Visit } from "./visit.js";
import { visitFromWire, visitToWire } from "./visit-wire.js";
import { BranchId, StationId, UserId, WorkflowId } from "../shared/ids.js";
import { parseJourneyCode } from "../journey/journey-code.js";

const IDENTITY = { includeIdentity: true } as const;

let counter = 0;
const deps = {
  clock: { now: () => new Date("2026-03-09T09:00:00Z") },
  ids: { next: () => `id-${(counter += 1)}` },
};

function admitted(): Visit {
  const visit = Visit.create(
    {
      journeyCode: parseJourneyCode("QM-8F4K"),
      branchId: BranchId("branch-main"),
      workflowId: WorkflowId("wf-1"),
      patient: { name: "Amara Okafor", hospitalNumber: "HN-4471", phone: "+2348012345678" },
    },
    deps,
  );
  visit.enqueue(StationId("station-consult"), {
    ordinal: 23,
    label: "A-023",
    periodKey: "2026-03-09",
  });
  return visit;
}

describe("visit wire format", () => {
  it("survives a round trip with its state intact", () => {
    const original = admitted();
    const restored = visitFromWire(visitToWire(original, IDENTITY), deps);

    expect(restored.id).toBe(original.id);
    expect(restored.journeyCode).toBe(original.journeyCode);
    expect(restored.status).toBe(original.status);
    expect(restored.priority).toBe(original.priority);
    expect(restored.patient.name).toBe("Amara Okafor");
    expect(restored.currentStationId).toBe(original.currentStationId);
  });

  it("restores instants as dates, not strings", () => {
    const restored = visitFromWire(visitToWire(admitted(), IDENTITY), deps);
    expect(restored.createdAt).toBeInstanceOf(Date);
    expect(restored.currentEntry?.queuedAt).toBeInstanceOf(Date);
  });

  it("keeps the ticket exactly as it was issued", () => {
    const restored = visitFromWire(visitToWire(admitted(), IDENTITY), deps);
    expect(restored.currentEntry?.queueLabel).toBe("A-023");
    expect(restored.currentEntry?.queueNumber).toBe(23);
    // The period is what lets a series be rebuilt after a restore.
    expect(restored.currentEntry?.queuePeriod).toBe("2026-03-09");
  });

  /**
   * A store that emitted `visit.created` on every page load would fill the
   * audit trail with admissions that never happened.
   */
  it("emits nothing when rebuilt", () => {
    const original = admitted();
    original.pullEvents();

    const restored = visitFromWire(visitToWire(original, IDENTITY), deps);
    expect(restored.hasPendingEvents).toBe(false);
    expect(restored.pullEvents()).toEqual([]);
  });

  /** A rebuilt visit is a working aggregate, not a frozen snapshot. */
  it("can be acted on after being rebuilt", () => {
    const restored = visitFromWire(visitToWire(admitted(), IDENTITY), deps);
    restored.call(UserId("user-1"));

    expect(restored.status).toBe("called");
    expect(restored.pullEvents().map((e) => e.type)).toContain("visit.called");
  });

  it("carries every queue entry, not only the current one", () => {
    const visit = admitted();
    visit.call(UserId("user-1"));
    visit.startService(UserId("user-1"));
    visit.routeTo(
      StationId("station-lab"),
      { ordinal: 4, label: "L-004", periodKey: "2026-03-09" },
      { actorId: UserId("user-1") },
    );

    const restored = visitFromWire(visitToWire(visit, IDENTITY), deps);
    expect(restored.queueEntries).toHaveLength(2);
    expect(restored.stationsVisited).toBe(visit.stationsVisited);
  });

  it("withholds every identifying field when identity is not permitted", () => {
    const wire = visitToWire(admitted(), { includeIdentity: false });

    expect(wire.patient).toEqual({ name: "", hospitalNumber: null, phone: null });
    expect(wire.identityWithheld).toBe(true);
    // Nothing identifying survives anywhere in the serialised form.
    const text = JSON.stringify(wire);
    expect(text).not.toContain("Amara");
    expect(text).not.toContain("HN-4471");
    expect(text).not.toContain("2348012345678");
  });

  it("still rebuilds a working aggregate from a withheld projection", () => {
    const restored = visitFromWire(visitToWire(admitted(), { includeIdentity: false }), deps);
    expect(restored.currentEntry?.queueLabel).toBe("A-023");
    expect(restored.patient.name).toBe("");
  });
});
