import { describe, expect, it } from "vitest";
import type { EventRecord } from "@qman/domain";
import {
  describeBoardEvent,
  describeEvent,
  EventStream,
  formatEvent,
  formatHeartbeat,
  HEARTBEAT_MILLIS,
} from "./stream.js";

const JOURNEY_CODE = "QM-8F4K";

function record(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "e1",
    sequence: 1,
    hospitalId: "hospital-1" as EventRecord["hospitalId"],
    branchId: "branch-main" as EventRecord["branchId"],
    category: "operational",
    type: "visit.called",
    visitId: "visit-1",
    correlationId: JOURNEY_CODE,
    actorId: null,
    occurredAt: new Date("2026-03-09T09:00:00Z"),
    recordedAt: new Date("2026-03-09T09:00:00Z"),
    payload: { stationId: "station-consult", queueLabel: "A-023", status: "called" },
    summary: `${JOURNEY_CODE} called`,
    ...overrides,
  } as EventRecord;
}

describe("wire format", () => {
  it("writes id, type and data, terminated by a blank line", () => {
    const chunk = formatEvent({
      id: "e1",
      type: "visit.called",
      branchId: "branch-main",
      payload: { ticket: "A-023" },
    });
    expect(chunk).toBe('id: e1\nevent: visit.called\ndata: {"ticket":"A-023"}\n\n');
  });

  /**
   * The format is newline-delimited. A payload containing a newline written raw
   * would be read as two events, the second a truncated fragment.
   */
  it("survives a payload containing newlines", () => {
    const chunk = formatEvent({
      id: "e1",
      type: "visit.called",
      branchId: "b",
      payload: { summary: "line one\nline two" },
    });
    const data = chunk.split("\n").filter((line) => line.startsWith("data: "));
    expect(data).toHaveLength(1);
  });

  it("writes the heartbeat as a comment", () => {
    expect(formatHeartbeat(new Date("2026-03-09T09:00:00Z"))).toBe(
      ": heartbeat 2026-03-09T09:00:00.000Z\n\n",
    );
  });

  /** Below the 45s staleness threshold, so a quiet clinic never looks broken. */
  it("beats more often than a surface calls itself stale", () => {
    expect(HEARTBEAT_MILLIS).toBeLessThan(45_000);
  });
});

describe("audience projections", () => {
  it("gives a staff workstation the correlation it needs to follow a patient", () => {
    const payload = describeEvent(record()).payload as Record<string, unknown>;
    expect(payload["correlationId"]).toBe(JOURNEY_CODE);
    expect(payload["visitId"]).toBe("visit-1");
    expect(payload["summary"]).toContain(JOURNEY_CODE);
  });

  /**
   * The Journey Code is printed on a patient's ticket and opens their tracking
   * page. A board that transmitted it would turn a photograph of a waiting-room
   * screen into a set of other people's lookup keys.
   */
  it("never gives a display board a Journey Code, by any route", () => {
    const payload = describeBoardEvent(record());
    const serialised = JSON.stringify(payload);

    expect(serialised).not.toContain(JOURNEY_CODE);
    expect(serialised).not.toContain("correlationId");
    // The summary is prose that contains the code.
    expect(serialised).not.toContain("summary");
  });

  /** An internal identifier correlates a person across stations for a collector. */
  it("never gives a display board a visit id", () => {
    expect(JSON.stringify(describeBoardEvent(record()))).not.toContain("visit-1");
  });

  it("gives a display board what the waiting room can already see", () => {
    const payload = describeBoardEvent(record()).payload as Record<string, unknown>;
    expect(payload["queueLabel"]).toBe("A-023");
    expect(payload["stationId"]).toBe("station-consult");
    expect(payload["status"]).toBe("called");
    expect(payload["at"]).toBe("2026-03-09T09:00:00.000Z");
  });

  /**
   * Built from scratch rather than by deleting fields, so a field added to the
   * staff projection cannot arrive here by omission. This is the test that
   * fails if someone later "simplifies" the two into one.
   */
  it("does not inherit fields added to the staff projection", () => {
    const withExtra = record({
      payload: {
        stationId: "station-consult",
        queueLabel: "A-023",
        status: "called",
        patientName: "Amara Okafor",
        hospitalNumber: "HN-4471",
      },
    });

    const serialised = JSON.stringify(describeBoardEvent(withExtra));
    expect(serialised).not.toContain("Amara");
    expect(serialised).not.toContain("HN-4471");
  });

  /** The wire carries no name for any audience. Policy decides rendering, not leaking. */
  it("never carries a patient name, even to staff", () => {
    const withName = record({
      payload: { stationId: "s", queueLabel: "A-023", patientName: "Amara Okafor" },
    });
    expect(JSON.stringify(describeEvent(withName))).not.toContain("Amara");
  });
});

describe("event fan-out", () => {
  function subscriber(audience: "staff" | "public", branchId: string | null = "branch-main") {
    const received: string[] = [];
    return { received, spec: { branchId, audience, send: (c: string) => received.push(c) } };
  }

  it("delivers to every subscriber in the branch", () => {
    const stream = new EventStream();
    const one = subscriber("staff");
    const two = subscriber("staff");
    stream.subscribe(one.spec);
    stream.subscribe(two.spec);

    stream.publish(record());

    expect(one.received).toHaveLength(1);
    expect(two.received).toHaveLength(1);
  });

  /**
   * The guarantee that makes the audience rule impossible to bypass: callers
   * hand the stream a record, not a payload, so a board cannot be sent the
   * staff projection even by mistake.
   */
  it("renders a different payload per audience from one publish", () => {
    const stream = new EventStream();
    const staff = subscriber("staff");
    const board = subscriber("public");
    stream.subscribe(staff.spec);
    stream.subscribe(board.spec);

    stream.publish(record());

    expect(staff.received[0]).toContain(JOURNEY_CODE);
    expect(board.received[0]).not.toContain(JOURNEY_CODE);
  });

  /**
   * A laboratory board showing consultation tickets is not a cosmetic error.
   * The waiting room acts on what it says.
   */
  it("does not deliver another branch's events", () => {
    const stream = new EventStream();
    const lab = subscriber("public", "branch-lab");
    stream.subscribe(lab.spec);

    stream.publish(record());
    expect(lab.received).toEqual([]);
  });

  it("delivers every branch to a subscriber that asked for no branch", () => {
    const stream = new EventStream();
    const all = subscriber("staff", null);
    stream.subscribe(all.spec);

    stream.publish(record());
    stream.publish(record({ branchId: "branch-lab" as EventRecord["branchId"] }));

    expect(all.received).toHaveLength(2);
  });

  /**
   * One client whose socket has gone must not stop the display board in the
   * next room from being told a patient was called.
   */
  it("drops a subscriber that fails, and keeps serving the rest", () => {
    const stream = new EventStream();
    const healthy = subscriber("staff");
    stream.subscribe({
      branchId: "branch-main",
      audience: "staff",
      send: () => {
        throw new Error("socket closed");
      },
    });
    stream.subscribe(healthy.spec);

    stream.publish(record());
    expect(healthy.received).toHaveLength(1);
    expect(stream.size).toBe(1);

    stream.publish(record({ id: "e2" }));
    expect(healthy.received).toHaveLength(2);
  });

  it("stops delivering once unsubscribed", () => {
    const stream = new EventStream();
    const one = subscriber("staff");
    const stop = stream.subscribe(one.spec);

    stream.publish(record());
    stop();
    stream.publish(record({ id: "e2" }));

    expect(one.received).toHaveLength(1);
    expect(stream.size).toBe(0);
  });

  it("beats to every subscriber regardless of branch or audience", () => {
    const stream = new EventStream();
    const board = subscriber("public", "branch-lab");
    stream.subscribe(board.spec);

    stream.heartbeat(new Date("2026-03-09T09:00:00Z"));
    expect(board.received[0]).toContain("heartbeat");
  });
});

describe("audience separation on the staff visit projection", () => {
  /**
   * The staff projection deliberately carries the patient, because a
   * workstation shows who is being called. The board and tracker projections
   * are built separately and must never inherit it.
   */
  it("keeps the patient out of the board projection entirely", () => {
    const withPatient = record({
      payload: {
        stationId: "station-consult",
        queueLabel: "A-023",
        status: "called",
        patientName: "Amara Okafor",
      },
    });

    expect(JSON.stringify(describeBoardEvent(withPatient))).not.toContain("Amara");
    expect(JSON.stringify(describeEvent(withPatient))).not.toContain("Amara");
  });
});
