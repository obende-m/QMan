import { describe, expect, it } from "vitest";
import {
  EventStream,
  formatEvent,
  formatHeartbeat,
  HEARTBEAT_MILLIS,
  type PublishedEvent,
} from "./stream.js";

function event(overrides: Partial<PublishedEvent> = {}): PublishedEvent {
  return {
    id: "e1",
    type: "visit.called",
    branchId: "branch-main",
    payload: { summary: "QM-8F4K called" },
    ...overrides,
  };
}

describe("event stream format", () => {
  it("writes id, type and data, terminated by a blank line", () => {
    const chunk = formatEvent(event());
    expect(chunk).toBe(
      'id: e1\nevent: visit.called\ndata: {"summary":"QM-8F4K called"}\n\n',
    );
  });

  /**
   * The format is newline-delimited. A payload containing a newline written
   * raw would be read as two events, the second a truncated fragment.
   */
  it("survives a payload containing newlines", () => {
    const chunk = formatEvent(event({ payload: { summary: "line one\nline two" } }));
    const dataLines = chunk.split("\n").filter((line) => line.startsWith("data: "));
    expect(dataLines).toHaveLength(1);
    expect(JSON.parse(dataLines[0]!.slice(6))).toEqual({ summary: "line one\nline two" });
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

describe("event fan-out", () => {
  it("delivers to every subscriber in the branch", () => {
    const stream = new EventStream();
    const main: string[] = [];
    const alsoMain: string[] = [];

    stream.subscribe({ branchId: "branch-main", send: (c) => main.push(c) });
    stream.subscribe({ branchId: "branch-main", send: (c) => alsoMain.push(c) });
    stream.publish(event());

    expect(main).toHaveLength(1);
    expect(alsoMain).toHaveLength(1);
  });

  /**
   * A laboratory board showing consultation tickets is not a cosmetic error.
   * The waiting room acts on what it says.
   */
  it("does not deliver another branch's events", () => {
    const stream = new EventStream();
    const lab: string[] = [];

    stream.subscribe({ branchId: "branch-lab", send: (c) => lab.push(c) });
    stream.publish(event({ branchId: "branch-main" }));

    expect(lab).toEqual([]);
  });

  it("delivers every branch to a subscriber that asked for no branch", () => {
    const stream = new EventStream();
    const all: string[] = [];

    stream.subscribe({ branchId: null, send: (c) => all.push(c) });
    stream.publish(event({ branchId: "branch-main" }));
    stream.publish(event({ branchId: "branch-lab" }));

    expect(all).toHaveLength(2);
  });

  /**
   * One client whose socket has gone must not stop the display board in the
   * next room from being told a patient was called.
   */
  it("drops a subscriber that fails, and keeps serving the rest", () => {
    const stream = new EventStream();
    const healthy: string[] = [];

    stream.subscribe({
      branchId: "branch-main",
      send: () => {
        throw new Error("socket closed");
      },
    });
    stream.subscribe({ branchId: "branch-main", send: (c) => healthy.push(c) });

    stream.publish(event());
    expect(healthy).toHaveLength(1);
    expect(stream.size).toBe(1);

    stream.publish(event({ id: "e2" }));
    expect(healthy).toHaveLength(2);
  });

  it("stops delivering once unsubscribed", () => {
    const stream = new EventStream();
    const received: string[] = [];
    const stop = stream.subscribe({ branchId: null, send: (c) => received.push(c) });

    stream.publish(event());
    stop();
    stream.publish(event({ id: "e2" }));

    expect(received).toHaveLength(1);
    expect(stream.size).toBe(0);
  });

  it("beats to every subscriber regardless of branch", () => {
    const stream = new EventStream();
    const lab: string[] = [];
    stream.subscribe({ branchId: "branch-lab", send: (c) => lab.push(c) });

    stream.heartbeat(new Date("2026-03-09T09:00:00Z"));
    expect(lab[0]).toContain("heartbeat");
  });
});
