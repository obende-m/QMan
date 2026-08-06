import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { UserId } from "@qman/domain";
import { ActivityExplorer } from "./ActivityExplorer.js";
import { ApiClient } from "../../api/client.js";
import { ActivityApi } from "../../data/activity-api.js";
import { OperationsStore } from "../../data/operations-store.js";
import {
  createFixture,
  STATION_IDS,
  USER_ID,
  type Fixture,
} from "../../test/api-fixture.js";

/**
 * Operational activity arrives on the server's event stream; administrative
 * activity is recorded by the portal as it saves. Both land in the same store,
 * which is what the explorer reads.
 */
async function wire() {
  const fixture = await createFixture();
  const ops = new OperationsStore(fixture.config);
  ops.attachToStream(fixture.stream);
  return {
    fixture,
    config: fixture.config,
    clinic: fixture.clinic,
    ops,
    auth: fixture.auth,
    /** Reads the recorded events back, as the audit screen does. */
    loadHistory: async () => {
      const client = new ApiClient({ baseUrl: "", readCookies: () => "" });
      const { events } = await new ActivityApi(client).read();
      ops.ingestHistory(events);
    },
  };
}

function openTab(name: RegExp): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("Activity Timeline", () => {
  let h: Awaited<ReturnType<typeof wire>>;

  beforeEach(async () => {
    h = await wire();
  });

  afterEach(() => {
    h.fixture.restore();
    cleanup();
  });

  it("shows operational activity", async () => {
    await act(async () => {
      await h.clinic.callNext(STATION_IDS.pharmacy, USER_ID);
    });
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    expect(screen.getByText(/Called at Pharmacy/)).toBeDefined();
  });

  /**
   * The separation that makes both screens usable: a hundred patient calls must
   * not bury the one configuration change that mattered.
   */
  it("keeps configuration changes out of the operational timeline", async () => {
    await act(async () => {
      await h.config.updateStation(STATION_IDS.consultation, {
        sla: { targetWaitMillis: 45 * 60_000, saturationPoint: 12 },
      });
      h.clinic.callNext(STATION_IDS.pharmacy, USER_ID);
    });

    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    expect(screen.getByText(/Called at Pharmacy/)).toBeDefined();
    expect(screen.queryByText(/SLA for Consultation/)).toBeNull();
  });

  it("correlates a whole journey by its Journey Code", async () => {
    const visit = h.clinic.visits[0]!;
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);

    await act(async () => {
      await h.clinic.callNext(STATION_IDS.pharmacy, USER_ID);
    });

    // Filter to one patient.
    fireEvent.change(screen.getByLabelText(/journey code/i), {
      target: { value: visit.journeyCode },
    });

    expect(
      screen.getByRole("heading", { name: /this visit, in order/i }),
    ).toBeDefined();
  });

  it("accepts a journey code however it is typed", async () => {
    // Only visits acted on after the bus was attached have events; the seed
    // pulls its own events during construction.
    await act(async () => {
      await h.clinic.callNext(STATION_IDS.pharmacy, USER_ID);
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
  it("carries the journey code on every event, not just the first", async () => {
    await act(async () => {
      await h.clinic.callNext(STATION_IDS.pharmacy, USER_ID);
    });
    expect(h.ops.audit.every((e) => e.correlationId?.startsWith("QM-"))).toBe(
      true,
    );
  });

  it("says so plainly when a journey code matches nothing", async () => {
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    fireEvent.change(screen.getByLabelText(/journey code/i), {
      target: { value: "QM-ZZZZ" },
    });
    expect(screen.getByText(/no activity for that journey code/i)).toBeDefined();
  });

  it("opens straight onto one journey when given a correlation id", async () => {
    const code = h.clinic.visits[0]!.journeyCode;
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

  it("filters by free text", async () => {
    await act(async () => {
      await h.clinic.callNext(STATION_IDS.pharmacy, USER_ID);
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

  it("names who did it", async () => {
    await act(async () => {
      await h.clinic.callNext(STATION_IDS.pharmacy, USER_ID);
    });
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    expect(screen.getAllByText(new RegExp(USER_ID)).length).toBeGreaterThan(0);
  });
});

describe("Audit Log", () => {
  let h: Awaited<ReturnType<typeof wire>>;

  beforeEach(async () => {
    h = await wire();
  });

  afterEach(() => {
    h.fixture.restore();
    cleanup();
  });

  it("records who changed an SLA, and to what", async () => {
    await act(async () => {
      await h.config.updateStation(STATION_IDS.consultation, {
        sla: { targetWaitMillis: 45 * 60_000, saturationPoint: 12 },
      });
    });

    await h.loadHistory();
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);

    // The specific change, not just "a station was updated".
    expect(screen.getByText(/SLA for Consultation set to 45 minute target/)).toBeDefined();
  });

  it("records a queue-numbering change distinctly from other station edits", async () => {
    await act(async () => {
      await h.config.updateStation(STATION_IDS.consultation, {
        queueNumber: { template: "OPD-{n:4}", reset: "weekly" },
      });
    });

    await h.loadHistory();
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);
    expect(
      screen.getByText(/Queue numbering for Consultation set to "OPD-\{n:4\}" \(weekly\)/),
    ).toBeDefined();
  });

  it("records a display board privacy change", async () => {
    await act(async () => {
      await h.config.updateBoard("board-main", { namePolicy: "full_name" });
    });

    await h.loadHistory();
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);
    expect(
      screen.getByText(/Display board Main Waiting Area name policy set to full_name/),
    ).toBeDefined();
  });

  it("keeps patient activity out of the audit log", async () => {
    await act(async () => {
      await h.clinic.callNext(STATION_IDS.pharmacy, USER_ID);
      await h.config.updateProfile({ name: "Lagos Central" });
    });

    await h.loadHistory();
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);

    expect(screen.getByText(/Hospital profile updated/)).toBeDefined();
    expect(screen.queryByText(/Called at Pharmacy/)).toBeNull();
  });

  it("records nothing when a configuration change is refused", async () => {
    await act(async () => {
      // Rejected: a template with no varying token.
      const result = await h.config.updateStation(STATION_IDS.consultation, {
        queueNumber: { template: "OPD", reset: "daily" } as never,
      });
      expect(result.ok).toBe(false);
    });

    await h.loadHistory();
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);
    // An audit trail that records changes which did not happen is worse than
    // none, because it is trusted.
    expect(screen.getByText(/no administrative activity/i)).toBeDefined();
  });

  it("groups an administrative sitting by session", async () => {
    await act(async () => {
      await h.config.updateProfile({ name: "Lagos Central" });
      await h.config.updateBoard("board-main", { waitingToShow: 6 });
    });

    await h.loadHistory();
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);

    const table = screen.getByRole("table");
    const sessionLinks = within(table).getAllByRole("button", { name: "session-1" });
    expect(sessionLinks.length).toBe(2);

    // Clicking one filters to everything done in that sitting.
    fireEvent.click(sessionLinks[0]!);
    expect(screen.getByDisplayValue("session-1")).toBeDefined();
  });

  it("distinguishes security records from configuration records", async () => {
    await act(async () => {
      h.ops.recordSecurityEvent({
        type: "auth.signed_in",
        summary: "Dr Adams signed in from Chrome on Windows",
        actorId: UserId("user-doctor"),
        correlationId: "sess-9",
      });
      await h.config.updateProfile({ name: "Lagos Central" });
    });

    await h.loadHistory();
    render(<ActivityExplorer operations={h.ops} auth={h.auth} />);
    openTab(/audit log/i);

    const table = screen.getByRole("table");
    expect(within(table).getByText("Security")).toBeDefined();
    expect(within(table).getByText("Config")).toBeDefined();
  });
});
