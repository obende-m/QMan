import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECTION_THRESHOLDS,
  assessConnection,
  describeConnection,
  formatFreshness,
} from "./connection.js";

const NOW = new Date("2026-03-09T10:00:00.000Z");

function secondsAgo(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

function at(seconds: number, attempting = true) {
  return assessConnection({
    lastUpdatedAt: secondsAgo(seconds),
    attempting,
    now: NOW,
  });
}

describe("connection state", () => {
  it("is connected while updates keep arriving", () => {
    const snapshot = at(5);
    expect(snapshot.state).toBe("connected");
    expect(snapshot.trustworthy).toBe(true);
    expect(describeConnection(snapshot).label).toBe("Live");
  });

  /**
   * Two missed beats before complaining. A board that warns every few minutes
   * because of a wi-fi stumble is a board nobody reads.
   */
  it("tolerates a missed update before doubting itself", () => {
    expect(at(30).state).toBe("connected");
    expect(at(50).state).toBe("stale");
  });

  /**
   * The whole point: a screen that has stopped receiving must stop claiming to
   * be current. Stale information presented as current is more dangerous than
   * none, because it is acted upon.
   */
  it("stops claiming to be live once the data is stale", () => {
    const snapshot = at(60);
    expect(snapshot.trustworthy).toBe(false);
    expect(describeConnection(snapshot).label).toBe("Data may be outdated");
  });

  it("reports a lost connection once the source has been silent for minutes", () => {
    const snapshot = at(300, false);
    expect(snapshot.state).toBe("offline");
    expect(describeConnection(snapshot).label).toBe("Connection lost");
    expect(describeConnection(snapshot).tone).toBe("critical");
  });

  /**
   * "Trying" and "given up" are different things to tell a waiting room.
   */
  it("distinguishes reconnecting from offline", () => {
    expect(at(300, true).state).toBe("reconnecting");
    expect(at(300, false).state).toBe("offline");
    expect(describeConnection(at(300, true)).label).toBe("Reconnecting…");
  });

  it("treats a first connection as connecting, not as a failure", () => {
    const snapshot = assessConnection({
      lastUpdatedAt: null,
      attempting: true,
      now: NOW,
    });
    expect(snapshot.state).toBe("connecting");
    expect(snapshot.trustworthy).toBe(false);
    expect(snapshot.ageMillis).toBe(0);
  });

  it("reports offline when nothing has arrived and nothing is being tried", () => {
    expect(
      assessConnection({ lastUpdatedAt: null, attempting: false, now: NOW })
        .state,
    ).toBe("offline");
  });

  it("never reports a negative age for a clock that runs ahead", () => {
    expect(at(-30).ageMillis).toBe(0);
  });

  it("honours custom thresholds", () => {
    const snapshot = assessConnection({
      lastUpdatedAt: secondsAgo(10),
      attempting: true,
      now: NOW,
      thresholds: { staleAfterMillis: 5_000, offlineAfterMillis: 20_000 },
    });
    expect(snapshot.state).toBe("stale");
  });

  it("uses thresholds consistent with device heartbeats", () => {
    // Same 15-second heartbeat assumption as ADR-029, so a board and the
    // Command Centre agree about when a screen has gone quiet.
    expect(DEFAULT_CONNECTION_THRESHOLDS.staleAfterMillis).toBe(45_000);
  });

  it("only ever calls one state trustworthy", () => {
    expect(at(5).trustworthy).toBe(true);
    expect(at(50).trustworthy).toBe(false);
    expect(at(300).trustworthy).toBe(false);
    expect(
      assessConnection({ lastUpdatedAt: null, attempting: true, now: NOW })
        .trustworthy,
    ).toBe(false);
  });
});

describe("freshness wording", () => {
  it("reads as a duration a person can judge", () => {
    expect(formatFreshness(at(2))).toBe("Updated just now");
    expect(formatFreshness(at(20))).toBe("Updated 20s ago");
    expect(formatFreshness(at(134))).toBe("Updated 2m 14s ago");
    expect(formatFreshness(at(3 * 3600 + 25 * 60))).toBe("Updated 3h 25m ago");
  });

  it("says so plainly when nothing has arrived", () => {
    expect(
      formatFreshness(
        assessConnection({ lastUpdatedAt: null, attempting: true, now: NOW }),
      ),
    ).toBe("No data yet");
  });
});

describe("wording for patients", () => {
  /**
   * A display board is read by patients, not engineers. Every degraded state
   * says what it means for the reader.
   */
  it("avoids jargon and tells the reader what to do", () => {
    expect(describeConnection(at(60)).label).not.toMatch(/stale/i);
    expect(describeConnection(at(300, false)).detail).toMatch(
      /ask at reception/i,
    );
    expect(describeConnection(at(300, true)).detail).toMatch(/ask staff/i);
  });
});
