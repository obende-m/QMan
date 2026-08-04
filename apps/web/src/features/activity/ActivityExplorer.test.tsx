import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { UserId } from "@qman/domain";
import { ActivityExplorer } from "./ActivityExplorer.js";
import { ClinicStore, CURRENT_USER } from "../../data/clinic-store.js";
import { OperationsStore } from "../../data/operations-store.js";
import { ConfigStore } from "../../data/config-store.js";
import { AuthStore } from "../../data/auth-store.js";
import { EventBus } from "../../data/event-bus.js";
import { STATION_IDS } from "../../data/config-store.js";

function wire() {
  const bus = new EventBus();
  const config = new ConfigStore();
  const clinic = new ClinicStore().useBus(bus);
  const ops = new OperationsStore(config);
  const auth = new AuthStore(config);

  ops.attachTo(bus);
  config.auditTo(({ type, summary }) =>
    ops.recordAdminEvent({
      type,
      summary,
      actorId: UserId("user-admin"),
      correlationId: "sess-1",
    }),
  );

  return { bus, config, clinic, ops, auth };
}

function openTab(name: RegExp): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("Activity Timeline", () => {
  let h: ReturnType<typeof wire>;

  beforeEach(() => {
    h = wire();
  });

  afterEach(cleanup);

  it("shows operational activity", () => {
    act(() => {
      h.clinic.callNext(STATION_IDS.pharmacy, CURRENT_USER);
    });
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    expect(screen.getByText(/Called at Pharmacy/)).toBeDefined();
  });

  /**
   * The separation that makes both screens usable: a hundred patient calls must
   * not bury the one configuration change that mattered.
   */
  it("keeps configuration changes out of the operational timeline", () => {
    act(() => {
      h.config.updateStation(STATION_IDS.consultation, {
        sla: { targetWaitMillis: 45 * 60_000, saturationPoint: 12 },
      });
      h.clinic.callNext(STATION_IDS.pharmacy, CURRENT_USER);
    });

    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    expect(screen.getByText(/Called at Pharmacy/)).toBeDefined();
    expect(screen.queryByText(/SLA for Consultation/)).toBeNull();
  });

  it("correlates a whole journey by its Journey Code", () => {
    const visit = h.clinic.visits[0]!.visit;
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);

    act(() => {
      h.clinic.callNext(STATION_IDS.pharmacy, CURRENT_USER);
    });

    // Filter to one patient.
    fireEvent.change(screen.getByLabelText(/journey code/i), {
      target: { value: visit.journeyCode },
    });

    expect(
      screen.getByRole("heading", { name: /this visit, in order/i }),
    ).toBeDefined();
  });

  it("accepts a journey code however it is typed", () => {
    // Only visits acted on after the bus was attached have events; the seed
    // pulls its own events during construction.
    act(() => {
      h.clinic.callNext(STATION_IDS.pharmacy, CURRENT_USER);
    });
    const code = h.ops.audit[0]!.correlationId!;
    expect(code).toMatch(/^QM-/);

    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    fireEvent.change(screen.getByLabelText(/journey code/i), {
      target: { value: code.toLowerCase() },
    });

    // Case-insensitive, because a correlation id is something a human types
    // off a printed ticket.
    expect(screen.queryByText(/no activity for that journey code/i)).toBeNull();
    expect(
      screen.getByRole("heading", { name: /this visit, in order/i }),
    ).toBeDefined();
  });

  /**
   * Correlation travels on the event itself, so a subscriber that joined late
   * still gets it — the case that matters once events arrive over a socket.
   */
  it("carries the journey code on every event, not just the first", () => {
    act(() => {
      h.clinic.callNext(STATION_IDS.pharmacy, CURRENT_USER);
    });
    expect(h.ops.audit.every((e) => e.correlationId?.startsWith("QM-"))).toBe(
      true,
    );
  });

  it("says so plainly when a journey code matches nothing", () => {
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    fireEvent.change(screen.getByLabelText(/journey code/i), {
      target: { value: "QM-ZZZZ" },
    });
    expect(screen.getByText(/no activity for that journey code/i)).toBeDefined();
  });

  it("opens straight onto one journey when given a correlation id", () => {
    const code = h.clinic.visits[0]!.visit.journeyCode;
    render(
      <ActivityExplorer
        operations={h.ops}
        auth={h.auth}
        initialCorrelationId={code}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /this visit, in order/i }),
    ).toBeDefined();
  });

  it("filters by free text", () => {
    act(() => {
      h.clinic.callNext(STATION_IDS.pharmacy, CURRENT_USER);
    });
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);

    fireEvent.change(screen.getByLabelText(/^search$/i), {
      target: { value: "pharmacy" },
    });
    expect(screen.getByText(/Called at Pharmacy/)).toBeDefined();

    fireEvent.change(screen.getByLabelText(/^search$/i), {
      target: { value: "radiology" },
    });
    expect(screen.queryByText(/Called at Pharmacy/)).toBeNull();
  });

  it("names who did it", () => {
    act(() => {
      h.clinic.callNext(STATION_IDS.pharmacy, CURRENT_USER);
    });
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    expect(screen.getAllByText(/Dr Adams/).length).toBeGreaterThan(0);
  });
});

describe("Audit Log", () => {
  let h: ReturnType<typeof wire>;

  beforeEach(() => {
    h = wire();
  });

  afterEach(cleanup);

  it("records who changed an SLA, and to what", () => {
    act(() => {
      h.config.updateStation(STATION_IDS.consultation, {
        sla: { targetWaitMillis: 45 * 60_000, saturationPoint: 12 },
      });
    });

    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);

    // The specific change, not just "a station was updated".
    expect(screen.getByText(/SLA for Consultation set to 45 minute target/)).toBeDefined();
  });

  it("records a queue-numbering change distinctly from other station edits", () => {
    act(() => {
      h.config.updateStation(STATION_IDS.consultation, {
        queueNumber: { template: "OPD-{n:4}", reset: "weekly" },
      });
    });

    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);
    expect(
      screen.getByText(/Queue numbering for Consultation set to "OPD-\{n:4\}" \(weekly\)/),
    ).toBeDefined();
  });

  it("records a display board privacy change", () => {
    act(() => {
      h.config.updateBoard("board-main", { namePolicy: "full_name" });
    });

    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);
    expect(
      screen.getByText(/Display board Main Waiting Area name policy set to full_name/),
    ).toBeDefined();
  });

  it("keeps patient activity out of the audit log", () => {
    act(() => {
      h.clinic.callNext(STATION_IDS.pharmacy, CURRENT_USER);
      h.config.updateProfile({ name: "Lagos Central" });
    });

    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);

    expect(screen.getByText(/Hospital profile updated/)).toBeDefined();
    expect(screen.queryByText(/Called at Pharmacy/)).toBeNull();
  });

  it("records nothing when a configuration change is refused", () => {
    act(() => {
      // Rejected: a template with no varying token.
      const result = h.config.updateStation(STATION_IDS.consultation, {
        queueNumber: { template: "OPD", reset: "daily" },
      });
      expect(result.ok).toBe(false);
    });

    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);
    // An audit trail that records changes which did not happen is worse than
    // none, because it is trusted.
    expect(screen.getByText(/no administrative activity/i)).toBeDefined();
  });

  it("groups an administrative sitting by session", () => {
    act(() => {
      h.config.updateProfile({ name: "Lagos Central" });
      h.config.updateBoard("board-main", { waitingToShow: 6 });
    });

    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);

    const table = screen.getByRole("table");
    const sessionLinks = within(table).getAllByRole("button", { name: "sess-1" });
    expect(sessionLinks.length).toBe(2);

    // Clicking one filters to everything done in that sitting.
    fireEvent.click(sessionLinks[0]!);
    expect(screen.getByDisplayValue("sess-1")).toBeDefined();
  });

  it("distinguishes security records from configuration records", () => {
    act(() => {
      h.ops.recordSecurityEvent({
        type: "auth.signed_in",
        summary: "Dr Adams signed in from Chrome on Windows",
        actorId: UserId("user-doctor"),
        correlationId: "sess-9",
      });
      h.config.updateProfile({ name: "Lagos Central" });
    });

    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);

    const table = screen.getByRole("table");
    expect(within(table).getByText("Security")).toBeDefined();
    expect(within(table).getByText("Config")).toBeDefined();
  });
});

describe("audit sinks", () => {
  it("records a failed sign-in without attributing it to anyone", async () => {
    const config = new ConfigStore();
    const ops = new OperationsStore(config);
    const auth = new AuthStore(config);
    auth.auditTo(({ type, summary, actorId, correlationId }) =>
      ops.recordSecurityEvent({ type, summary, actorId, correlationId }),
    );
    auth.registerProvider({
      id: "local",
      name: "Local",
      kind: "password",
      enabled: true,
      async authenticate() {
        return {
          ok: false,
          reason: "invalid_credentials",
          message: "Nope",
        };
      },
    });

    await auth.signIn("local", { username: "ifeoma", password: "wrong" });

    const record = ops.audit.find((e) => e.type === "auth.sign_in_failed")!;
    expect(record.summary).toMatch(/Failed sign-in for "ifeoma"/);
    // A failed attempt has not proved who it was; attributing it would put a
    // name against someone else's mistyped password.
    expect(record.actorId).toBeNull();
  });
});
