import { describe, expect, it } from "vitest";
import {
  FixedClock,
  StationId,
  UserId,
  Visit,
  WorkflowId,
  parseJourneyCode,
  type IdGenerator,
} from "@qman/domain";
import {
  MappingError,
  fromEventRecord,
  fromSession,
  fromVisit,
  toEventRecord,
  toSession,
  toStationConfig,
  toVisit,
  toVisitState,
  toWorkflow,
} from "./mappers.js";
import type { EventRow, QueueEntryRow, SessionRow, StationRow, VisitRow } from "./rows.js";

class Ids implements IdGenerator {
  #n = 0;
  next(): string {
    this.#n += 1;
    return `id-${this.#n}`;
  }
}

const deps = () => ({ clock: new FixedClock(), ids: new Ids() });

const BRANCH = "branch-1";
const CONSULT = StationId("st-consultation");
const LAB = StationId("st-laboratory");

function visitRow(overrides: Partial<VisitRow> = {}): VisitRow {
  return {
    id: "visit-1",
    branch_id: BRANCH,
    workflow_id: "wf-1",
    journey_code: "QM-8F4K",
    patient_name: "Amara Okafor",
    hospital_number: "HN-40128",
    phone: null,
    status: "queued",
    priority: "normal",
    current_queue_entry_id: "qe-1",
    created_at: new Date("2026-03-09T08:00:00Z"),
    completed_at: null,
    closed_at: null,
    ...overrides,
  };
}

function entryRow(overrides: Partial<QueueEntryRow> = {}): QueueEntryRow {
  return {
    id: "qe-1",
    visit_id: "visit-1",
    station_id: CONSULT,
    queue_number: 23,
    queue_label: "A-023",
    queue_period: "2026-03-09",
    status: "waiting",
    assigned_user_id: null,
    queued_at: new Date("2026-03-09T08:05:00Z"),
    called_at: null,
    started_at: null,
    completed_at: null,
    call_attempts: 0,
    skipped: false,
    skip_reason: null,
    sequence: 1,
    ...overrides,
  };
}

describe("visit mapping", () => {
  it("reconstitutes a visit from its rows", () => {
    const state = toVisitState(visitRow(), [entryRow()]);

    expect(state.journeyCode).toBe("QM-8F4K");
    expect(state.status).toBe("queued");
    expect(state.patient.hospitalNumber).toBe("HN-40128");
    expect(state.queueEntries).toHaveLength(1);
    expect(state.queueEntries[0]!.queueLabel).toBe("A-023");
  });

  /**
   * Ordering is by the explicit sequence column, never by timestamp: two legs
   * can share a millisecond and the journey would then read out of order.
   */
  it("orders queue entries by sequence, not by time", () => {
    const sameInstant = new Date("2026-03-09T08:05:00Z");
    const state = toVisitState(visitRow(), [
      entryRow({ id: "qe-2", sequence: 2, station_id: LAB, queued_at: sameInstant }),
      entryRow({ id: "qe-1", sequence: 1, queued_at: sameInstant }),
    ]);

    expect(state.queueEntries.map((e) => e.id)).toEqual(["qe-1", "qe-2"]);
  });

  it("round-trips a visit through rows without losing anything", () => {
    const d = deps();
    const visit = Visit.create(
      {
        journeyCode: parseJourneyCode("QM-8F4K"),
        branchId: BRANCH as never,
        workflowId: WorkflowId("wf-1"),
        patient: {
          name: "Amara Okafor",
          hospitalNumber: "HN-40128",
          phone: "+234800",
        },
        priority: "high",
      },
      d,
    );
    visit.enqueue(CONSULT, { ordinal: 23, label: "A-023", periodKey: "2026-03-09" });
    visit.call(UserId("user-doctor"));
    visit.startService(UserId("user-doctor"));
    d.clock.advanceMinutes(6);
    visit.routeTo(LAB, { ordinal: 11, label: "L-011", periodKey: "2026-03-09" });
    visit.pullEvents();

    const { visit: row, entries } = fromVisit(visit);
    const restored = toVisit(row, entries, deps());

    expect(restored.status).toBe(visit.status);
    expect(restored.priority).toBe("high");
    expect(restored.journeyCode).toBe(visit.journeyCode);
    expect(restored.currentStationId).toBe(LAB);
    expect(restored.patient).toEqual(visit.patient);
    expect(restored.queueEntries).toHaveLength(2);
    expect(restored.currentEntry?.queueLabel).toBe("L-011");

    // The completed leg keeps every timestamp, which is what every metric is
    // computed from.
    const first = restored.queueEntries[0]!;
    expect(first.status).toBe("completed");
    expect(first.startedAt).not.toBeNull();
    expect(first.completedAt).not.toBeNull();
  });

  it("assigns queue entry sequence from journey order", () => {
    const d = deps();
    const visit = Visit.create(
      {
        journeyCode: parseJourneyCode("QM-8F4K"),
        branchId: BRANCH as never,
        workflowId: WorkflowId("wf-1"),
        patient: { name: "Test", hospitalNumber: null, phone: null },
      },
      d,
    );
    visit.enqueue(CONSULT, { ordinal: 1, label: "A-001", periodKey: "2026-03-09" });
    visit.call(UserId("u"));
    visit.startService(UserId("u"));
    visit.routeTo(LAB, { ordinal: 1, label: "L-001", periodKey: "2026-03-09" });

    const { entries } = fromVisit(visit);
    expect(entries.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("carries a restored visit forward through the state machine", () => {
    const restored = toVisit(
      visitRow({ status: "called" }),
      [entryRow({ status: "called", called_at: new Date() })],
      deps(),
    );
    restored.startService(UserId("user-doctor"));
    expect(restored.status).toBe("in_progress");
  });

  /**
   * A row whose enum column holds something the domain has never heard of is a
   * migration problem or a manual edit. Failing loudly at the boundary is far
   * cheaper than a visit that silently cannot be acted on.
   */
  it("refuses a row with an unknown status", () => {
    expect(() => toVisitState(visitRow({ status: "paused" }), [])).toThrow(
      MappingError,
    );
    expect(() => toVisitState(visitRow({ status: "paused" }), [])).toThrow(
      /visits\.status/,
    );
  });

  it("refuses a row with an unknown priority or queue status", () => {
    expect(() => toVisitState(visitRow({ priority: "urgent" }), [])).toThrow(
      MappingError,
    );
    expect(() =>
      toVisitState(visitRow(), [entryRow({ status: "parked" })]),
    ).toThrow(/queue_entries\.status/);
  });

  it("refuses a malformed journey code", () => {
    expect(() =>
      toVisitState(visitRow({ journey_code: "NOPE" }), []),
    ).toThrow(/journey_code/);
  });

  it("names the offending row so it can be found", () => {
    try {
      toVisitState(visitRow({ id: "visit-42", status: "paused" }), []);
      expect.unreachable();
    } catch (error) {
      expect((error as MappingError).rowId).toBe("visit-42");
      expect((error as Error).message).toMatch(/visit-42/);
    }
  });
});

describe("event mapping", () => {
  function eventRow(overrides: Partial<EventRow> = {}): EventRow {
    return {
      id: "ev-1",
      hospital_id: "hosp-1",
      branch_id: BRANCH,
      sequence: "1024",
      category: "operational",
      type: "visit.called",
      visit_id: "visit-1",
      correlation_id: "QM-8F4K",
      actor_id: "user-doctor",
      occurred_at: new Date("2026-03-09T09:00:00Z"),
      recorded_at: new Date("2026-03-09T09:00:01Z"),
      payload: { stationId: CONSULT, queueLabel: "A-023" },
      summary: "Called at Consultation",
      ...overrides,
    };
  }

  /**
   * bigserial exceeds Number.MAX_SAFE_INTEGER, so drivers return it as a
   * string. Parsing at the boundary keeps that out of every caller.
   */
  it("parses a bigserial sequence into a number", () => {
    expect(toEventRecord(eventRow()).sequence).toBe(1024);
    expect(toEventRecord(eventRow({ sequence: 7 })).sequence).toBe(7);
  });

  it("preserves the payload and the rendered summary", () => {
    const record = toEventRecord(eventRow());
    expect(record.payload).toEqual({
      stationId: CONSULT,
      queueLabel: "A-023",
    });
    expect(record.summary).toBe("Called at Consultation");
  });

  it("rejects an unknown category", () => {
    expect(() => toEventRecord(eventRow({ category: "clinical" }))).toThrow(
      MappingError,
    );
  });

  /**
   * Category is derived from the type on write rather than trusted from the
   * caller: a record filed under the wrong category is invisible on the screen
   * that should show it.
   */
  it("derives category from the event type when writing", () => {
    expect(
      fromEventRecord({
        hospitalId: "hosp-1" as never,
        branchId: BRANCH as never,
        // Deliberately mislabelled by the caller.
        category: "operational",
        type: "auth.signed_in",
        visitId: null,
        correlationId: "sess-1",
        actorId: null,
        occurredAt: new Date(),
        payload: {},
        summary: "Signed in",
      }).category,
    ).toBe("security");

    expect(
      fromEventRecord({
        hospitalId: "hosp-1" as never,
        branchId: BRANCH as never,
        category: "operational",
        type: "config.sla_updated",
        visitId: null,
        correlationId: "sess-1",
        actorId: null,
        occurredAt: new Date(),
        payload: {},
        summary: "SLA changed",
      }).category,
    ).toBe("administrative");
  });
});

describe("configuration mapping", () => {
  function stationRow(overrides: Partial<StationRow> = {}): StationRow {
    return {
      id: CONSULT,
      branch_id: BRANCH,
      name: "Consultation",
      code: "OPD",
      room: "Room 12",
      staffing: 3,
      service_estimate_ms: 720_000,
      sla_target_wait_ms: 1_800_000,
      sla_saturation_point: 12,
      queue_template: "A-{n:3}",
      queue_reset: "daily",
      queue_manual_epoch: null,
      is_public: true,
      enabled: true,
      ...overrides,
    };
  }

  it("maps a station and its queue numbering", () => {
    const station = toStationConfig(stationRow());
    expect(station.name).toBe("Consultation");
    expect(station.queueNumber).toEqual({
      template: "A-{n:3}",
      reset: "daily",
    });
    expect(station.sla.targetWaitMillis).toBe(1_800_000);
  });

  it("includes the manual epoch only when set", () => {
    expect(
      toStationConfig(
        stationRow({ queue_reset: "manual", queue_manual_epoch: "session-2" }),
      ).queueNumber,
    ).toEqual({ template: "A-{n:3}", reset: "manual", manualEpoch: "session-2" });

    expect(
      "manualEpoch" in toStationConfig(stationRow()).queueNumber,
    ).toBe(false);
  });

  it("rejects an unknown reset strategy", () => {
    expect(() =>
      toStationConfig(stationRow({ queue_reset: "fortnightly" })),
    ).toThrow(MappingError);
  });

  it("orders workflow stages by sequence and maps branches", () => {
    const workflow = toWorkflow(
      { id: "wf-1", branch_id: BRANCH, name: "OPD", is_default: true },
      [
        {
          id: "s2",
          workflow_id: "wf-1",
          station_id: LAB,
          sequence: 2,
          is_required: false,
          allow_skip: true,
          allow_repeat: false,
          branches_to: [CONSULT],
        },
        {
          id: "s1",
          workflow_id: "wf-1",
          station_id: CONSULT,
          sequence: 1,
          is_required: true,
          allow_skip: false,
          allow_repeat: true,
          branches_to: [],
        },
      ],
    );

    expect(workflow.stages.map((s) => s.stationId)).toEqual([CONSULT, LAB]);
    expect(workflow.stages[1]!.branchesTo).toEqual([CONSULT]);
    expect(workflow.stages[0]!.allowRepeat).toBe(true);
  });
});

describe("session mapping", () => {
  const row: SessionRow = {
    id: "sess-1",
    user_id: "user-doctor",
    branch_id: BRANCH,
    provider_id: "local",
    device: "Chrome on Windows",
    user_agent: "Mozilla/5.0",
    started_at: new Date("2026-03-09T08:00:00Z"),
    last_active_at: new Date("2026-03-09T09:30:00Z"),
    ended_at: null,
    end_reason: null,
  };

  it("round-trips a session", () => {
    expect(fromSession(toSession(row))).toEqual(row);
  });

  it("maps an ended session with its reason", () => {
    const ended = toSession({
      ...row,
      ended_at: new Date("2026-03-09T10:00:00Z"),
      end_reason: "terminated_by_admin",
    });
    expect(ended.endReason).toBe("terminated_by_admin");
  });

  it("rejects an unknown end reason", () => {
    expect(() => toSession({ ...row, end_reason: "vanished" })).toThrow(
      MappingError,
    );
  });
});
