import { describe, expect, it } from "vitest";
import {
  assessDevice,
  assessPresence,
  channelHealth,
  unhealthyDevices,
  unstaffedStations,
  type DeviceHeartbeat,
  type NotificationAttempt,
} from "./operational-health.js";
import { BranchId, StationId, UserId, VisitId } from "../shared/ids.js";

const NOW = new Date("2026-03-09T10:00:00.000Z");
const BRANCH = BranchId("branch-main");
const LAB = StationId("st-lab");
const CONSULT = StationId("st-consultation");

function secondsAgo(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

function board(id: string, lastSeenSecondsAgo: number): DeviceHeartbeat {
  return {
    deviceId: id,
    kind: "display_board",
    name: `Board ${id}`,
    branchId: BRANCH,
    lastSeenAt: secondsAgo(lastSeenSecondsAgo),
  };
}

describe("device health", () => {
  it("is online while heartbeats keep arriving", () => {
    expect(assessDevice(board("a", 5), NOW).status).toBe("online");
  });

  /**
   * Two missed beats before complaining. A board that alarms on every flaky
   * wi-fi moment is a board nobody looks at.
   */
  it("tolerates a missed heartbeat before flagging", () => {
    expect(assessDevice(board("a", 30), NOW).status).toBe("online");
    expect(assessDevice(board("a", 50), NOW).status).toBe("stale");
  });

  it("declares a device offline once it has been silent for minutes", () => {
    expect(assessDevice(board("a", 200), NOW).status).toBe("offline");
  });

  it("reports how long a device has been silent", () => {
    expect(assessDevice(board("a", 90), NOW).silentForMillis).toBe(90_000);
  });

  it("never reports negative silence for a clock skew", () => {
    // A device whose clock runs ahead must not produce a negative duration.
    expect(assessDevice(board("a", -30), NOW).silentForMillis).toBe(0);
  });

  it("lists only unhealthy devices, longest silence first", () => {
    const unhealthy = unhealthyDevices(
      [board("ok", 2), board("stale", 60), board("dead", 400)],
      NOW,
    );
    expect(unhealthy.map((d) => d.heartbeat.deviceId)).toEqual(["dead", "stale"]);
  });
});

describe("notification delivery health", () => {
  const attempt = (
    overrides: Partial<NotificationAttempt> = {},
  ): NotificationAttempt => ({
    id: Math.random().toString(),
    channel: "browser",
    status: "delivered",
    visitId: VisitId("v1"),
    recipient: "patient",
    occurredAt: secondsAgo(30),
    error: null,
    ...overrides,
  });

  it("reports a healthy channel", () => {
    const health = channelHealth(
      [attempt(), attempt(), attempt()],
      NOW,
    ).find((c) => c.channel === "browser")!;

    expect(health.delivered).toBe(3);
    expect(health.failureRate).toBe(0);
    expect(health.healthy).toBe(true);
  });

  it("flags a channel that is mostly failing", () => {
    const health = channelHealth(
      [
        attempt({ status: "failed" }),
        attempt({ status: "failed" }),
        attempt({ status: "delivered" }),
      ],
      NOW,
    ).find((c) => c.channel === "browser")!;

    expect(health.failureRate).toBeCloseTo(2 / 3);
    expect(health.healthy).toBe(false);
  });

  /**
   * The rule that keeps the panel usable: a patient who declined notification
   * permission is not a broken channel. Counting them as failures would keep
   * the light permanently red and train managers to ignore it.
   */
  it("does not count declined permission as a delivery failure", () => {
    const health = channelHealth(
      [
        attempt({ status: "denied" }),
        attempt({ status: "denied" }),
        attempt({ status: "unsupported" }),
        attempt({ status: "delivered" }),
      ],
      NOW,
    ).find((c) => c.channel === "browser")!;

    expect(health.declined).toBe(3);
    expect(health.failureRate).toBe(0);
    expect(health.healthy).toBe(true);
  });

  it("ignores attempts outside the window", () => {
    const health = channelHealth(
      [attempt({ occurredAt: secondsAgo(3600), status: "failed" }), attempt()],
      NOW,
    ).find((c) => c.channel === "browser")!;

    expect(health.attempted).toBe(1);
    expect(health.failed).toBe(0);
  });

  it("treats a channel with no traffic as healthy, not broken", () => {
    const health = channelHealth([], NOW).find((c) => c.channel === "sms")!;
    expect(health.attempted).toBe(0);
    expect(health.failureRate).toBeNull();
    expect(health.healthy).toBe(true);
  });
});

describe("staff presence", () => {
  const doctor = UserId("user-doctor");

  it("counts recent action as being at the post", () => {
    const presence = assessPresence(
      { userId: doctor, stationId: CONSULT, lastActionAt: secondsAgo(60) },
      NOW,
    );
    expect(presence.status).toBe("active");
  });

  it("becomes idle, then away", () => {
    expect(
      assessPresence(
        { userId: doctor, stationId: CONSULT, lastActionAt: secondsAgo(15 * 60) },
        NOW,
      ).status,
    ).toBe("idle");

    expect(
      assessPresence(
        { userId: doctor, stationId: CONSULT, lastActionAt: secondsAgo(45 * 60) },
        NOW,
      ).status,
    ).toBe("away");
  });

  /**
   * The most actionable signal in the module: a queue nobody is working will
   * not clear on its own, and queue length alone does not reveal it.
   */
  it("finds queues with patients waiting and nobody serving", () => {
    const unstaffed = unstaffedStations({
      stationsWithWaiting: [LAB, CONSULT],
      presence: [
        assessPresence(
          { userId: doctor, stationId: CONSULT, lastActionAt: secondsAgo(30) },
          NOW,
        ),
      ],
    });
    expect(unstaffed).toEqual([LAB]);
  });

  it("does not count an idle member of staff as covering a station", () => {
    const unstaffed = unstaffedStations({
      stationsWithWaiting: [CONSULT],
      presence: [
        assessPresence(
          { userId: doctor, stationId: CONSULT, lastActionAt: secondsAgo(40 * 60) },
          NOW,
        ),
      ],
    });
    expect(unstaffed).toEqual([CONSULT]);
  });

  it("reports nothing unstaffed when no queues have patients", () => {
    expect(
      unstaffedStations({ stationsWithWaiting: [], presence: [] }),
    ).toEqual([]);
  });
});
