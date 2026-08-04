import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCKOUT_POLICY,
  NO_LOCKOUT,
  attemptsRemaining,
  checkPassword,
  isLocked,
  recordFailure,
  recordSuccess,
} from "./password.js";
import {
  DEFAULT_SESSION_POLICY,
  describeDevice,
  endSession,
  idleForMillis,
  isUsable,
  sessionStatus,
  touch,
  type Session,
} from "./session.js";
import { BranchId, UserId } from "../shared/ids.js";

const NOW = new Date("2026-03-09T10:00:00.000Z");

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    userId: UserId("user-doctor"),
    branchId: BranchId("branch-main"),
    providerId: "local",
    startedAt: minutesAgo(60),
    lastActiveAt: minutesAgo(5),
    endedAt: null,
    endReason: null,
    device: "Chrome on Windows",
    userAgent: "",
    ...overrides,
  };
}

describe("password rules", () => {
  it("accepts a long passphrase", () => {
    const result = checkPassword("correct horse battery staple");
    expect(result.ok).toBe(true);
    expect(result.strength).toBeGreaterThanOrEqual(2);
  });

  /**
   * Length is the property that matters. Composition rules produce `Password1!`
   * and a sticky note on the reception monitor.
   */
  it("rejects a short password however complex", () => {
    const result = checkPassword("Aa1!xY");
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/at least 10 characters/);
  });

  it("rejects the passwords attackers try first", () => {
    expect(checkPassword("password123").ok).toBe(false);
    expect(checkPassword("hospital123").ok).toBe(false);
  });

  it("rejects a password containing the username", () => {
    const result = checkPassword("ifeoma-is-here", { username: "ifeoma" });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/your username/);
  });

  /**
   * The obvious scoring — a point per character class — rates `Ab1!Ab1!Ab`
   * above a long passphrase, which teaches users exactly the wrong lesson.
   */
  it("scores a long passphrase above a short but varied password", () => {
    const long = checkPassword("a much longer passphrase here");
    const varied = checkPassword("Ab1!Ab1!Ab");
    expect(long.strength).toBeGreaterThan(varied.strength);
  });

  it("gives a failing password no strength at all", () => {
    expect(checkPassword("short").strength).toBe(0);
  });
});

describe("account lockout", () => {
  it("locks after the configured number of failures", () => {
    let state = NO_LOCKOUT;
    for (let i = 0; i < DEFAULT_LOCKOUT_POLICY.maxFailures; i += 1) {
      expect(isLocked(state, NOW)).toBe(false);
      state = recordFailure(state, NOW);
    }
    expect(isLocked(state, NOW)).toBe(true);
  });

  it("unlocks once the lock expires", () => {
    let state = NO_LOCKOUT;
    for (let i = 0; i < 5; i += 1) state = recordFailure(state, NOW);

    const later = new Date(
      NOW.getTime() + DEFAULT_LOCKOUT_POLICY.lockDurationMillis + 1000,
    );
    expect(isLocked(state, later)).toBe(false);
  });

  /**
   * A rolling window, not a running total: someone who mistypes twice on Monday
   * and three times on Friday has not been attacked.
   */
  it("forgets failures that fall outside the window", () => {
    let state = NO_LOCKOUT;
    const longAgo = new Date(NOW.getTime() - 60 * 60_000);
    for (let i = 0; i < 4; i += 1) state = recordFailure(state, longAgo);

    state = recordFailure(state, NOW);
    expect(isLocked(state, NOW)).toBe(false);
    expect(attemptsRemaining(state, NOW)).toBe(4);
  });

  it("clears the slate on a successful sign-in", () => {
    let state = NO_LOCKOUT;
    for (let i = 0; i < 3; i += 1) state = recordFailure(state, NOW);
    expect(attemptsRemaining(recordSuccess(), NOW)).toBe(5);
  });

  it("warns before locking", () => {
    let state = NO_LOCKOUT;
    state = recordFailure(state, NOW);
    state = recordFailure(state, NOW);
    expect(attemptsRemaining(state, NOW)).toBe(3);
  });
});

describe("sessions", () => {
  it("is active while recently used", () => {
    expect(sessionStatus(session(), NOW)).toBe("active");
    expect(isUsable(session(), NOW)).toBe(true);
  });

  it("reports idle without ending the session", () => {
    const idle = session({ lastActiveAt: minutesAgo(45) });
    expect(sessionStatus(idle, NOW)).toBe("idle");
    // Idle is advisory — it helps an administrator spot an unattended machine.
    expect(isUsable(idle, NOW)).toBe(true);
  });

  it("expires after the idle timeout", () => {
    const stale = session({
      startedAt: minutesAgo(60 * 20),
      lastActiveAt: minutesAgo(60 * 13),
    });
    expect(sessionStatus(stale, NOW)).toBe("expired");
    expect(isUsable(stale, NOW)).toBe(false);
  });

  /**
   * A shared workstation that is never idle because someone is always at it
   * still has to be signed out eventually.
   */
  it("expires at the absolute cap even with constant activity", () => {
    const marathon = session({
      startedAt: minutesAgo(60 * 25),
      lastActiveAt: minutesAgo(1),
    });
    expect(sessionStatus(marathon, NOW)).toBe("expired");
  });

  it("extends on activity", () => {
    const s = session({ lastActiveAt: minutesAgo(45) });
    expect(sessionStatus(s, NOW)).toBe("idle");
    touch(s, NOW);
    expect(sessionStatus(s, NOW)).toBe("active");
    expect(idleForMillis(s, NOW)).toBe(0);
  });

  it("records why a session ended", () => {
    const s = session();
    endSession(s, "terminated_by_admin", NOW);
    expect(sessionStatus(s, NOW)).toBe("ended");
    expect(s.endReason).toBe("terminated_by_admin");
    expect(isUsable(s, NOW)).toBe(false);
  });

  it("does not re-end an already ended session", () => {
    const s = session();
    endSession(s, "signed_out", NOW);
    const firstEnd = s.endedAt;
    endSession(s, "terminated_by_admin", new Date(NOW.getTime() + 60_000));
    expect(s.endedAt).toEqual(firstEnd);
    expect(s.endReason).toBe("signed_out");
  });

  it("ignores activity on an ended session", () => {
    const s = session();
    endSession(s, "signed_out", NOW);
    const last = s.lastActiveAt;
    touch(s, new Date(NOW.getTime() + 60_000));
    expect(s.lastActiveAt).toEqual(last);
  });

  it("uses a generous timeout so staff do not work around it", () => {
    // A doctor signed out mid-consultation shares a login that never locks.
    expect(DEFAULT_SESSION_POLICY.idleTimeoutMillis).toBeGreaterThanOrEqual(
      8 * 60 * 60_000,
    );
  });
});

describe("device description", () => {
  it("names the browser and platform an administrator can walk to", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      ),
    ).toBe("Chrome on Windows");
  });

  it("distinguishes Edge from Chrome", () => {
    expect(
      describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120"),
    ).toBe("Edge on Windows");
  });

  it("distinguishes Safari from Chrome on iOS", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1 Version/17.0 Safari/605.1",
      ),
    ).toBe("Safari on iOS");
  });

  it("degrades gracefully on something unrecognised", () => {
    expect(describeDevice("some-kiosk-agent/1.0")).toBe(
      "Browser on Unknown device",
    );
  });
});
