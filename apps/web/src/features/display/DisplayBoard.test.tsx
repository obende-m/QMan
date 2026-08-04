import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { DisplayBoard } from "./DisplayBoard.js";
import { CURRENT_USER, ClinicStore } from "../../data/clinic-store.js";
import { STATIONS } from "../../data/demo-clinic.js";
import { boardById, type DisplayBoardConfig } from "../../data/display-boards.js";

const MAIN = boardById("board-main");

function panelFor(name: RegExp): HTMLElement {
  return screen.getByRole("region", { name });
}

describe("Display Board", () => {
  let store: ClinicStore;

  beforeEach(() => {
    store = new ClinicStore();
  });

  afterEach(cleanup);

  it("shows a panel per configured station, not just one at a time", () => {
    render(<DisplayBoard config={MAIN} store={store} />);
    expect(panelFor(/consultation queue/i)).toBeDefined();
    expect(panelFor(/laboratory queue/i)).toBeDefined();
    expect(panelFor(/pharmacy queue/i)).toBeDefined();
  });

  it("shows only the stations a board is configured for", () => {
    const labOnly: DisplayBoardConfig = boardById("board-lab");
    render(<DisplayBoard config={labOnly} store={store} />);
    expect(panelFor(/laboratory queue/i)).toBeDefined();
    expect(screen.queryByRole("region", { name: /pharmacy queue/i })).toBeNull();
    expect(
      screen.queryByRole("region", { name: /consultation queue/i }),
    ).toBeNull();
  });

  it("separates the serving ticket from the waiting queue", () => {
    render(<DisplayBoard config={MAIN} store={store} />);
    const consultation = panelFor(/consultation queue/i);

    const serving = store.worklist(STATIONS.consultation).current!;
    within(consultation).getByText(/now serving/i);
    expect(within(consultation).getByText(serving.entry.queueLabel)).toBeDefined();
    expect(within(consultation).getByText(/^waiting$/i)).toBeDefined();
  });

  it("calls patients by station ticket, using each station's own format", () => {
    render(<DisplayBoard config={MAIN} store={store} />);

    // Consultation issues an A- series, Laboratory an L- series, Pharmacy a P-.
    const consultation = panelFor(/consultation queue/i);
    const laboratory = panelFor(/laboratory queue/i);

    expect(consultation.textContent).toMatch(/A-\d{3}/);
    expect(laboratory.textContent).toMatch(/L-\d{3}/);
  });

  it("does not put patient names on a public screen by default", () => {
    render(<DisplayBoard config={MAIN} store={store} />);
    expect(MAIN.namePolicy).toBe("ticket_only");
    for (const { visit } of store.visits) {
      expect(screen.queryByText(visit.patient.name)).toBeNull();
    }
  });

  it("shows first names only when a clinic chooses that policy", () => {
    const firstNames: DisplayBoardConfig = { ...MAIN, namePolicy: "first_name" };
    render(<DisplayBoard config={firstNames} store={store} />);

    const serving = store.worklist(STATIONS.consultation).current!;
    const [first] = serving.patientName.split(" ");
    expect(screen.getAllByText(first!).length).toBeGreaterThan(0);
    // The surname must not leak under a first-name policy.
    expect(screen.queryByText(serving.patientName)).toBeNull();
  });

  it("shows the full name when a clinic opts all the way in", () => {
    const named: DisplayBoardConfig = { ...MAIN, namePolicy: "full_name" };
    render(<DisplayBoard config={named} store={store} />);
    const serving = store.worklist(STATIONS.consultation).current!;
    expect(screen.getAllByText(serving.patientName).length).toBeGreaterThan(0);
  });

  it("shows the room so patients know where to walk", () => {
    render(<DisplayBoard config={MAIN} store={store} />);
    expect(screen.getByText("Room 12")).toBeDefined();
  });

  it("shows an estimated wait for new arrivals", () => {
    render(<DisplayBoard config={MAIN} store={store} />);
    expect(screen.getAllByText(/new arrivals ≈/i).length).toBeGreaterThan(0);
  });

  it("numbers waiting positions independently of the ticket", () => {
    render(<DisplayBoard config={MAIN} store={store} />);
    const consultation = panelFor(/consultation queue/i);
    // Position 1 exists and is distinct from the ticket label beside it.
    expect(within(consultation).getByLabelText("Position 1")).toBeDefined();
  });

  it("caps the waiting list and reports the overflow", () => {
    const tight: DisplayBoardConfig = { ...MAIN, waitingToShow: 1 };
    render(<DisplayBoard config={tight} store={store} />);
    const consultation = panelFor(/consultation queue/i);
    const waitingCount = store.worklist(STATIONS.consultation).counts.waiting;
    if (waitingCount > 1) {
      expect(consultation.textContent).toMatch(
        new RegExp(`\\+${waitingCount - 1} more waiting`),
      );
    }
  });

  /**
   * The behaviour the requirement calls "automatic queue updates": staff act at
   * a station, and the board follows with no manual reordering anywhere.
   */
  it("moves the next patient up automatically when one is called", () => {
    render(<DisplayBoard config={MAIN} store={store} />);
    const pharmacy = panelFor(/pharmacy queue/i);

    const nextUp = store.worklist(STATIONS.pharmacy).waiting[0]!;
    expect(within(pharmacy).queryByText(/now serving/i)).toBeDefined();

    // The store is external to React, so the subscription flush has to be
    // wrapped — exactly as a websocket message from the API will be.
    act(() => {
      store.callNext(STATIONS.pharmacy, CURRENT_USER);
    });

    // The board re-rendered from the store subscription, with no refresh.
    const updated = panelFor(/pharmacy queue/i);
    const servingBlock = within(updated).getByText(/now serving/i).parentElement!;
    expect(servingBlock.textContent).toContain(nextUp.entry.queueLabel);
  });

  it("removes a patient from the station once they are routed onward", () => {
    render(<DisplayBoard config={MAIN} store={store} />);
    const serving = store.worklist(STATIONS.consultation).current!;

    act(() => {
      store.route(serving.visitId, STATIONS.laboratory, CURRENT_USER);
    });

    const consultation = panelFor(/consultation queue/i);
    expect(consultation.textContent).not.toContain(serving.entry.queueLabel);

    // And they appear at the destination under a brand-new station ticket.
    const moved = store.find(serving.visitId)!;
    expect(moved.visit.currentStationId).toBe(STATIONS.laboratory);
    expect(moved.visit.currentEntry!.queueLabel).not.toBe(
      serving.entry.queueLabel,
    );
  });

  it("shows an empty station honestly rather than a stale ticket", () => {
    render(<DisplayBoard config={boardById("board-lab")} store={store} />);
    const serving = store.worklist(STATIONS.laboratory).current!;
    act(() => {
      store.route(serving.visitId, STATIONS.consultation, CURRENT_USER);
    });

    const laboratory = panelFor(/laboratory queue/i);
    expect(laboratory.textContent).not.toContain(serving.entry.queueLabel);
  });
});

/**
 * The correctness fix: a board that keeps saying "Live" while its source has
 * gone quiet is worse than one that admits it, because a waiting room acts on
 * what it reads.
 */
describe("Display Board connection honesty", () => {
  let store: ClinicStore;

  beforeEach(() => {
    store = new ClinicStore();
  });

  afterEach(cleanup);

  it("says it is live while the source keeps reporting", async () => {
    render(<DisplayBoard config={MAIN} store={store} />);
    expect(await screen.findByText("Live")).toBeDefined();
  });

  it("does not show a freshness line while the data is trustworthy", () => {
    render(<DisplayBoard config={MAIN} store={store} />);
    // Clean when healthy; the age only earns its place once it matters.
    expect(screen.queryByText(/Updated .* ago/)).toBeNull();
  });

  it("stops claiming to be live once the source falls silent", async () => {
    vi.useFakeTimers();
    try {
      render(<DisplayBoard config={MAIN} store={store} />);

      // Nothing calls keepAlive(): the transport has gone away.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(screen.queryByText("Live")).toBeNull();
      expect(screen.getByText(/Data may be outdated/)).toBeDefined();
      expect(screen.getByText(/Updated .* ago/)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a lost connection after minutes of silence", async () => {
    vi.useFakeTimers();
    try {
      render(<DisplayBoard config={MAIN} store={store} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4 * 60_000);
      });

      expect(screen.getByText(/Reconnecting…|Connection lost/)).toBeDefined();
      expect(screen.getByText(/ask staff|ask at reception/i)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers as soon as the source reports again", async () => {
    vi.useFakeTimers();
    try {
      render(<DisplayBoard config={MAIN} store={store} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.queryByText("Live")).toBeNull();

      await act(async () => {
        store.keepAlive();
        await vi.advanceTimersByTimeAsync(1_100);
      });

      expect(screen.getByText("Live")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps showing the queue while stale rather than blanking the screen", async () => {
    vi.useFakeTimers();
    try {
      render(<DisplayBoard config={MAIN} store={store} />);
      const serving = store.worklist(STATIONS.consultation).current!;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      // Something, clearly labelled as possibly out of date, beats nothing.
      expect(screen.getByText(serving.entry.queueLabel)).toBeDefined();
      expect(screen.getByText(/Data may be outdated/)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Journey Code and queue number are different identities", () => {
  let store: ClinicStore;

  beforeEach(() => {
    store = new ClinicStore();
  });

  afterEach(cleanup);

  it("keeps the Journey Code fixed while the station ticket changes", () => {
    const serving = store.worklist(STATIONS.consultation).current!;
    const visit = store.find(serving.visitId)!.visit;

    const journeyCodeBefore = visit.journeyCode;
    const ticketBefore = visit.currentEntry!.queueLabel;

    store.route(visit.id, STATIONS.laboratory, CURRENT_USER);

    expect(visit.journeyCode).toBe(journeyCodeBefore);
    expect(visit.currentEntry!.queueLabel).not.toBe(ticketBefore);
    expect(visit.currentEntry!.queueLabel).toMatch(/^L-\d{3}$/);
  });

  it("preserves the ticket each station issued on the visit's history", () => {
    const serving = store.worklist(STATIONS.consultation).current!;
    const visit = store.find(serving.visitId)!.visit;
    store.route(visit.id, STATIONS.laboratory, CURRENT_USER);

    // Every leg keeps the label it was issued — the audit trail does not
    // re-render under the destination station's format.
    const labels = visit.queueEntries.map((entry) => entry.queueLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.at(-1)).toMatch(/^L-/);
  });
});
