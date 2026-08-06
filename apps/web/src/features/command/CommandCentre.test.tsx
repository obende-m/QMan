import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { UserId } from "@qman/domain";
import { CommandCentre } from "./CommandCentre.js";
import type { ClinicStore } from "../../data/clinic-store.js";
import { OperationsStore } from "../../data/operations-store.js";
import { EventBus } from "../../data/event-bus.js";
import {
  BRANCH_ID as BRANCH,
  createFixture,
  STATION_IDS,
  USER_ID,
  type Fixture,
} from "../../test/api-fixture.js";

/**
 * The clinic comes from the API; operations telemetry is still browser-held,
 * so it keeps its own bus.
 */
async function wire(): Promise<{
  fixture: Fixture;
  clinic: ClinicStore;
  ops: OperationsStore;
  bus: EventBus;
}> {
  const fixture = await createFixture();
  const bus = new EventBus();
  const ops = new OperationsStore();
  ops.attachTo(bus);
  return { fixture, clinic: fixture.clinic, ops, bus };
}

function attention(): HTMLElement {
  return screen
    .getByRole("heading", { name: /needs attention|nothing needs attention/i })
    .closest("section")!;
}

describe("Operational Command Centre", () => {
  let clinic: ClinicStore;
  let ops: OperationsStore;
  let bus: EventBus;

  let fixture: Fixture;

  beforeEach(async () => {
    ({ clinic, ops, bus, fixture } = await wire());
  });

  afterEach(() => {
    fixture.restore();
    cleanup();
  });

  it("renders", () => {
    render(<CommandCentre store={clinic} operations={ops} />);
    expect(screen.getByRole("heading", { name: /command centre/i })).toBeDefined();
  });

  it("shows queue health for every station", () => {
    render(<CommandCentre store={clinic} operations={ops} />);
    const card = screen
      .getByRole("heading", { name: /queue health/i })
      .closest("section")!;
    expect(within(card).getAllByRole("meter").length).toBeGreaterThan(3);
  });

  it("raises an alert for a station over its wait target", () => {
    render(<CommandCentre store={clinic} operations={ops} />);
    // The seeded clinic has long-waiting patients.
    expect(attention().textContent).toMatch(/over its wait target/i);
  });

  /**
   * The most actionable signal: a queue nobody is working will not clear on its
   * own, and queue length alone does not reveal it.
   */
  it("raises a critical alert for a queue with nobody serving it", () => {
    render(<CommandCentre store={clinic} operations={ops} />);
    expect(attention().textContent).toMatch(/has nobody serving/i);
  });

  it("clears the unstaffed alert once someone works that station", () => {
    render(<CommandCentre store={clinic} operations={ops} />);
    expect(attention().textContent).toMatch(/pharmacy has nobody serving/i);

    act(() => {
      clinic.callNext(STATION_IDS.pharmacy, USER_ID);
    });

    expect(attention().textContent).not.toMatch(/pharmacy has nobody serving/i);
  });

  it("is honest that no display board has reported rather than claiming health", () => {
    render(<CommandCentre store={clinic} operations={ops} />);
    const card = screen
      .getByRole("heading", { name: /display boards/i })
      .closest("section")!;
    expect(card.textContent).toMatch(/no board has reported in/i);
  });

  it("reports a display board that has gone offline", () => {
    ops.heartbeat(
      {
        deviceId: "board-main",
        kind: "display_board",
        name: "Main Waiting Area",
        branchId: BRANCH,
      },
      // Silent for ten minutes.
      new Date(Date.now() - 10 * 60_000),
    );

    render(<CommandCentre store={clinic} operations={ops} />);
    expect(attention().textContent).toMatch(/Main Waiting Area is offline/i);
    expect(attention().textContent).toMatch(/cannot see their number/i);
  });

  it("treats a board that is checking in as healthy", () => {
    ops.heartbeat({
      deviceId: "board-main",
      kind: "display_board",
      name: "Main Waiting Area",
      branchId: BRANCH,
    });
    render(<CommandCentre store={clinic} operations={ops} />);

    const card = screen
      .getByRole("heading", { name: /display boards/i })
      .closest("section")!;
    expect(card.textContent).toMatch(/every screen is live/i);
    expect(attention().textContent).not.toMatch(/offline/i);
  });

  it("flags a failing notification channel", () => {
    for (let i = 0; i < 5; i += 1) {
      ops.recordAttempt({
        channel: "browser",
        status: "failed",
        visitId: null,
        recipient: "patient",
        occurredAt: new Date(),
        error: "Permission revoked",
      });
    }
    render(<CommandCentre store={clinic} operations={ops} />);
    expect(attention().textContent).toMatch(/browser notifications are failing/i);
  });

  it("does not treat declined permissions as a failing channel", () => {
    for (let i = 0; i < 5; i += 1) {
      ops.recordAttempt({
        channel: "browser",
        status: "denied",
        visitId: null,
        recipient: "patient",
        occurredAt: new Date(),
        error: null,
      });
    }
    render(<CommandCentre store={clinic} operations={ops} />);
    expect(attention().textContent).not.toMatch(/notifications are failing/i);
  });

  /**
   * Everything downstream of a clinical action arrives through the event bus.
   * Calling a patient must produce an announcement, an audit entry and a
   * notification attempt without the queue engine knowing any of them exist.
   */
  it("records an announcement, an audit entry and a notification from one call", () => {
    render(<CommandCentre store={clinic} operations={ops} />);

    act(() => {
      clinic.callNext(STATION_IDS.pharmacy, USER_ID);
    });

    expect(ops.announcements[0]!.text).toMatch(/please proceed to Pharmacy/i);
    expect(ops.audit.some((e) => /Called at Pharmacy/.test(e.summary))).toBe(true);
    expect(ops.attempts.some((a) => a.channel === "browser")).toBe(true);

    const announcements = screen
      .getByRole("heading", { name: /recent announcements/i })
      .closest("section")!;
    expect(announcements.textContent).toMatch(/please proceed to Pharmacy/i);
  });

  it("infers staff presence from actions, not from sessions", () => {
    render(<CommandCentre store={clinic} operations={ops} />);

    act(() => {
      clinic.callNext(STATION_IDS.pharmacy, USER_ID);
    });

    const card = screen
      .getByRole("heading", { name: /staff on the floor/i })
      .closest("section")!;
    expect(within(card).getByText(/Dr Adams/)).toBeDefined();
    expect(card.textContent).toMatch(/Pharmacy/);
  });

  it("shows the audit trail of what actually happened", () => {
    render(<CommandCentre store={clinic} operations={ops} />);

    act(() => {
      const current = clinic.worklist(STATION_IDS.consultation).current!;
      clinic.route(current.visitId, STATION_IDS.laboratory, USER_ID);
    });

    const card = screen
      .getByRole("heading", { name: /^activity$/i })
      .closest("section")!;
    expect(card.textContent).toMatch(/Consultation → Laboratory/);
  });

  it("keeps working when a subscriber throws", () => {
    // The bus logs the failure by design; silenced here so the expected error
    // does not look like a real one in test output.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // A broken announcement must not stop the audit trail recording that a
    // patient was called.
    bus.subscribe({
      name: "broken",
      handle: () => {
        throw new Error("boom");
      },
    });

    render(<CommandCentre store={clinic} operations={ops} />);
    act(() => {
      clinic.callNext(STATION_IDS.pharmacy, UserId("user-doctor"));
    });

    expect(ops.audit.some((e) => /Called at Pharmacy/.test(e.summary))).toBe(true);
    expect(bus.failures.get("broken")).toBeGreaterThan(0);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
