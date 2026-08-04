import { describe, expect, it } from "vitest";
import {
  VISIT_ACTIONS,
  VISIT_STATUSES,
  allowedActions,
  canTransition,
  isTerminal,
  nextStatus,
} from "./visit-status.js";
import { IllegalTransitionError } from "../shared/errors.js";

describe("visit state machine", () => {
  it("walks the documented happy path", () => {
    let status = nextStatus("created", "enqueue");
    expect(status).toBe("queued");
    status = nextStatus(status, "call");
    expect(status).toBe("called");
    status = nextStatus(status, "start");
    expect(status).toBe("in_progress");
    status = nextStatus(status, "route");
    expect(status).toBe("queued");
    status = nextStatus(status, "call");
    status = nextStatus(status, "start");
    status = nextStatus(status, "complete");
    expect(status).toBe("completed");
    expect(nextStatus(status, "close")).toBe("closed");
  });

  it("refuses shortcuts through the lifecycle", () => {
    // The rule the SAD states as "no shortcuts": a queued patient cannot be
    // served without first being called.
    expect(() => nextStatus("queued", "start")).toThrow(IllegalTransitionError);
    expect(() => nextStatus("created", "call")).toThrow(IllegalTransitionError);
    expect(() => nextStatus("created", "complete")).toThrow(
      IllegalTransitionError,
    );
  });

  it("explains itself to staff when it refuses", () => {
    expect(() => nextStatus("queued", "start")).toThrow(
      /Call the patient before starting service/,
    );
    expect(() => nextStatus("closed", "call")).toThrow(
      /closed and can no longer be modified/,
    );
  });

  it("treats closed as the only terminal state", () => {
    expect(allowedActions("closed")).toEqual([]);
    expect(isTerminal("closed")).toBe(true);
    // Cancelled is not terminal — it must still be closable so the record seals.
    expect(isTerminal("cancelled")).toBe(false);
    expect(allowedActions("cancelled")).toEqual(["close"]);
  });

  it("allows a completed visit to be reopened for review", () => {
    // The lab-result review leg of the SAD's example journey.
    expect(canTransition("completed", "route")).toBe(true);
    expect(nextStatus("completed", "route")).toBe("queued");
  });

  it("only permits skipping a patient who was actually called", () => {
    expect(canTransition("called", "skip")).toBe(true);
    expect(canTransition("queued", "skip")).toBe(false);
    expect(canTransition("in_progress", "skip")).toBe(false);
  });

  it("never transitions to a state outside the declared set", () => {
    for (const from of VISIT_STATUSES) {
      for (const action of VISIT_ACTIONS) {
        if (!canTransition(from, action)) continue;
        expect(VISIT_STATUSES).toContain(nextStatus(from, action));
      }
    }
  });

  it("can always reach a terminal state from any state", () => {
    // Guards against a configuration in which a visit could get stuck forever.
    for (const from of VISIT_STATUSES) {
      const seen = new Set([from]);
      const frontier = [from];
      let reachedClosed = false;
      while (frontier.length > 0) {
        const state = frontier.pop()!;
        if (isTerminal(state)) {
          reachedClosed = true;
          break;
        }
        for (const action of allowedActions(state)) {
          const to = nextStatus(state, action);
          if (!seen.has(to)) {
            seen.add(to);
            frontier.push(to);
          }
        }
      }
      expect(reachedClosed, `"${from}" cannot reach closed`).toBe(true);
    }
  });
});
