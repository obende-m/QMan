import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { UserId } from "@qman/domain";
import { CommandCentre } from "./CommandCentre.js";
import type { ClinicStore } from "../../data/clinic-store.js";
import { OperationsStore } from "../../data/operations-store.js";
import { Notifier } from "../../runtime/notifier.js";
import {
  BRANCH_ID as BRANCH,
  createFixture,
  STATION_IDS,
  USER_ID,
  type Fixture,
} from "../../test/api-fixture.js";

/**
 * Telemetry reads the server's event stream, exactly as production does. An
 * action goes to the API, the API publishes, and OperationsStore consumes.
 */
async function wire(): Promise<{
  fixture: Fixture;
  clinic: ClinicStore;
  ops: OperationsStore;
}> {
  const fixture = await createFixture();
  const ops = new OperationsStore(fixture.config);
  ops.attachToStream(fixture.stream);

  // The notifier reads the same stream, so a call produces a delivery attempt
  // exactly as it does in production.
  const notifier = new Notifier({
    notifications: {
      permission: "granted",
      requestPermission: async () => "granted",
      show: async () => true,
    },
    operations: ops,
    config: fixture.config,
  });
  notifier.attachToStream(fixture.stream, STATION_IDS.pharmacy);

  // The patient waiting at Pharmacy is the one this suite calls, so their
  // notification is the delivery attempt it asserts.
  const atPharmacy = fixture.clinic.worklist(STATION_IDS.pharmacy).waiting[0];
  if (atPharmacy) notifier.attachPatientToStream(fixture.stream, atPharmacy.visitId);

  return { fixture, clinic: fixture.clinic, ops };
}

function attention(): HTMLElement {
  return screen
    .getByRole("heading", { name: /needs attention|nothing needs attention/i })
    .closest("section")!;
}

describe("Operational Command Centre", () => {
  let clinic: ClinicStore;
  let ops: OperationsStore;

  let fixture: Fixture;

  beforeEach(async () => {
    ({ clinic, ops, fixture } = await wire());
  });

  afterEach(() => {
    fixture.restore();
    cleanup();
  });

  it("renders", async () => {
    render(<CommandCentre store={clinic} operations={ops} />);
    expect(screen.getByRole("heading", { name: /command centre/i })).toBeDefined();
  });

  it("shows queue health for every station", async () => {
    render(<CommandCentre store={clinic} operations={ops} />);
    const card = screen
      .getByRole("heading", { name: /queue health/i })
      .closest("section")!;
    expect(within(card).getAllByRole("meter").length).toBeGreaterThan(3);
  });

  it("raises an alert for a station over its wait target", async () => {
    render(<CommandCentre store={clinic} operations={ops} />);
    // The seeded clinic has long-waiting patients.
    expect(attention().textContent).toMatch(/over its wait target/i);
  });

  /**
   * The most actionable signal: a queue nobody is working will not clear on its
   * own, and queue length alone does not reveal it.
   */
  it("raises a critical alert for a queue with nobody serving it", async () => {
    render(<CommandCentre store={clinic} operations={ops} />);
    expect(attention().textContent).toMatch(/has nobody serving/i);
  });

  it("clears the unstaffed alert once someone works that station", async () => {
    render(<CommandCentre store={clinic} operations={ops} />);
    expect(attention().textContent).toMatch(/pharmacy has nobody serving/i);

    await act(async () => {
      await clinic.callNext(STATION_IDS.pharmacy, USER_ID);
    });

    expect(attention().textContent).not.toMatch(/pharmacy has nobody serving/i);
  });

  it("is honest that no display board has reported rather than claiming health", async () => {
    render(<CommandCentre store={clinic} operations={ops} />);
    const card = screen
      .getByRole("heading", { name: /display boards/i })
      .closest("section")!;
    expect(card.textContent).toMatch(/no board has reported in/i);
  });

  it("reports a display board that has gone offline", async () => {
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

  it("treats a board that is checking in as healthy", async () => {
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

  it("flags a failing notification channel", async () => {
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

  it("does not treat declined permissions as a failing channel", async () => {
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
  it("records an announcement, an audit entry and a notification from one call", async () => {
    render(<CommandCentre store={clinic} operations={ops} />);

    await act(async () => {
      await clinic.callNext(STATION_IDS.pharmacy, USER_ID);
    });

    expect(ops.announcements[0]!.text).toMatch(/please proceed to Pharmacy/i);
    expect(ops.audit.some((e) => /Called at Pharmacy/.test(e.summary))).toBe(true);
    expect(ops.attempts.some((a) => a.channel === "browser")).toBe(true);

    const announcements = screen
      .getByRole("heading", { name: /recent announcements/i })
      .closest("section")!;
    expect(announcements.textContent).toMatch(/please proceed to Pharmacy/i);
  });

  it("infers staff presence from actions, not from sessions", async () => {
    render(<CommandCentre store={clinic} operations={ops} />);

    await act(async () => {
      await clinic.callNext(STATION_IDS.pharmacy, USER_ID);
    });

    const card = screen
      .getByRole("heading", { name: /staff on the floor/i })
      .closest("section")!;
    // Staff are identified by id: there is no user directory endpoint, so a
    // name would have to be invented. Presence is still inferred from the
    // action, which is what this test is about.
    expect(within(card).getByText(new RegExp(USER_ID))).toBeDefined();
    expect(card.textContent).toMatch(/Pharmacy/);
  });

  it("shows the audit trail of what actually happened", async () => {
    render(<CommandCentre store={clinic} operations={ops} />);

    await act(async () => {
      const current = clinic.worklist(STATION_IDS.consultation).current!;
      await clinic.route(current.visitId, STATION_IDS.laboratory, USER_ID);
    });

    const card = screen
      .getByRole("heading", { name: /^activity$/i })
      .closest("section")!;
    expect(card.textContent).toMatch(/Consultation → Laboratory/);
  });

  /**
   * One failing consumer must not stop the others. The audit trail is the one
   * that matters: a broken announcement cannot be allowed to lose the record
   * that a patient was called.
   */
  it("keeps recording when one consumer throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.stream.onEvent(() => {
      throw new Error("boom");
    });

    render(<CommandCentre store={clinic} operations={ops} />);
    await act(async () => {
      await clinic.callNext(STATION_IDS.pharmacy, USER_ID);
    });

    expect(ops.audit.some((e) => /Called at Pharmacy/.test(e.summary))).toBe(true);
    logged.mockRestore();
  });
});
