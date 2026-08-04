import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PatientJourney } from "./PatientJourney.js";
import { CURRENT_USER, ClinicStore } from "../../data/clinic-store.js";
import { STATIONS } from "../../data/demo-clinic.js";
import type { DemoVisit } from "../../data/demo-clinic.js";

describe("Patient Journey Tracking", () => {
  let store: ClinicStore;
  let waiting: DemoVisit;

  beforeEach(() => {
    store = new ClinicStore();
    // A patient who is queued and not yet called — the common case.
    waiting = store.visits.find(({ visit }) => visit.status === "queued")!;
  });

  afterEach(cleanup);

  it("asks for a journey code and needs no account", () => {
    render(<PatientJourney store={store} />);
    expect(screen.getByLabelText(/journey code/i)).toBeDefined();
    expect(screen.getByText(/no account needed/i)).toBeDefined();
  });

  it("finds a visit from a code typed however the patient managed it", () => {
    render(<PatientJourney store={store} />);
    const code = waiting.visit.journeyCode;

    fireEvent.change(screen.getByLabelText(/journey code/i), {
      // Lower case, no prefix, stray spaces — all should resolve.
      target: { value: ` ${code.replace("QM-", "").toLowerCase()} ` },
    });
    fireEvent.click(screen.getByRole("button", { name: /track my visit/i }));

    expect(screen.getByText(waiting.visit.patient.name)).toBeDefined();
  });

  it("explains itself when the code is wrong instead of failing silently", () => {
    render(<PatientJourney store={store} />);
    fireEvent.change(screen.getByLabelText(/journey code/i), {
      target: { value: "QM-ZZZZ" },
    });
    fireEvent.click(screen.getByRole("button", { name: /track my visit/i }));

    const error = screen.getByRole("alert");
    expect(error.textContent).toMatch(/couldn't find that code/i);
    expect(error.textContent).toMatch(/ask at reception/i);
  });

  it("opens straight onto the journey when arrived at by QR", () => {
    render(
      <PatientJourney store={store} initialCode={waiting.visit.journeyCode} />,
    );
    expect(screen.getByText(waiting.visit.patient.name)).toBeDefined();
    expect(screen.queryByLabelText(/journey code/i)).toBeNull();
  });

  it("shows position, people ahead, estimated wait, ticket and room", () => {
    render(
      <PatientJourney store={store} initialCode={waiting.visit.journeyCode} />,
    );

    const position = store.positionOf(waiting.visit.id)!;
    const ahead = store.aheadOf(waiting.visit.id)!;

    expect(screen.getByText(`#${position}`)).toBeDefined();
    expect(screen.getByText(/estimated wait/i)).toBeDefined();
    expect(
      screen.getByText(waiting.visit.currentEntry!.queueLabel),
    ).toBeDefined();
    expect(screen.getByText(/go to/i)).toBeDefined();

    if (ahead === 0) {
      expect(screen.getByText(/you are next in line/i)).toBeDefined();
    } else {
      expect(
        screen.getByText(new RegExp(`${ahead} (person|people) ahead`, "i")),
      ).toBeDefined();
    }
  });

  /**
   * The clarification that drove this screen: the ticket is fixed for the stop,
   * the position moves as the queue does.
   */
  it("keeps the ticket fixed while the position counts down", () => {
    render(
      <PatientJourney store={store} initialCode={waiting.visit.journeyCode} />,
    );

    const stationId = waiting.visit.currentStationId!;
    const ticket = waiting.visit.currentEntry!.queueLabel;
    const positionBefore = store.positionOf(waiting.visit.id)!;

    // Clear the patient ahead of them so the queue advances.
    act(() => {
      const current = store.worklist(stationId).current;
      if (current) store.complete(current.visitId, CURRENT_USER);
      const next = store.worklist(stationId).waiting[0];
      if (next && next.visitId !== waiting.visit.id) {
        store.callNext(stationId, CURRENT_USER);
        store.complete(next.visitId, CURRENT_USER);
      }
    });

    const positionAfter = store.positionOf(waiting.visit.id);
    if (positionAfter !== null && positionBefore > 1) {
      expect(positionAfter).toBeLessThan(positionBefore);
    }
    // The ticket did not change with it.
    expect(waiting.visit.currentEntry!.queueLabel).toBe(ticket);
  });

  it("tells the patient plainly when it is their turn", () => {
    const stationId = waiting.visit.currentStationId!;
    // Clear the station, then call this patient up.
    const current = store.worklist(stationId).current;
    if (current) store.complete(current.visitId, CURRENT_USER);
    store.recall(waiting.visit.id, CURRENT_USER);

    render(
      <PatientJourney store={store} initialCode={waiting.visit.journeyCode} />,
    );

    expect(screen.getByText(/it's your turn/i)).toBeDefined();
    expect(screen.getByText(/please go to/i)).toBeDefined();
  });

  it("closes the loop when the visit is complete", () => {
    const done = store.visits.find(({ visit }) => visit.status === "completed")!;
    render(<PatientJourney store={store} initialCode={done.visit.journeyCode} />);
    expect(screen.getByText(/your visit is complete/i)).toBeDefined();
    expect(screen.getByText(/you may now leave/i)).toBeDefined();
  });

  it("shows the journey timeline, including what is still ahead", () => {
    render(
      <PatientJourney store={store} initialCode={waiting.visit.journeyCode} />,
    );
    const section = screen
      .getByRole("heading", { name: /your journey/i })
      .closest("section")!;
    const steps = section.querySelectorAll("li");
    expect(steps.length).toBeGreaterThan(1);
  });

  /**
   * The tracker's numbers are the ones a patient acts on — they decide whether
   * to stay in their seat on the strength of "#2, ~15 mins". A page that has
   * stopped updating must not present them as current.
   */
  it("says it is live while the source keeps reporting", () => {
    render(
      <PatientJourney store={store} initialCode={waiting.visit.journeyCode} />,
    );
    expect(screen.getByText("Live")).toBeDefined();
    expect(screen.queryByText(/may be out of date/i)).toBeNull();
  });

  it("casts doubt on the numbers once it stops receiving updates", async () => {
    vi.useFakeTimers();
    try {
      render(
        <PatientJourney store={store} initialCode={waiting.visit.journeyCode} />,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(screen.queryByText("Live")).toBeNull();
      // Not just a badge: the figures themselves carry the warning.
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toMatch(/These numbers may be out of date/);
      expect(alert.textContent).toMatch(/ask at reception/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still shows the journey while stale rather than hiding it", async () => {
    vi.useFakeTimers();
    try {
      render(
        <PatientJourney store={store} initialCode={waiting.visit.journeyCode} />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      // Something labelled as possibly out of date beats a blank screen.
      expect(screen.getByText(waiting.visit.journeyCode)).toBeDefined();
      expect(screen.getByLabelText(/your position/i)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers as soon as the source reports again", async () => {
    vi.useFakeTimers();
    try {
      render(
        <PatientJourney store={store} initialCode={waiting.visit.journeyCode} />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.queryByText("Live")).toBeNull();

      await act(async () => {
        store.keepAlive();
        await vi.advanceTimersByTimeAsync(1_100);
      });

      expect(screen.getByText("Live")).toBeDefined();
      expect(screen.queryByText(/may be out of date/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates live as the clinic moves", () => {
    render(
      <PatientJourney store={store} initialCode={waiting.visit.journeyCode} />,
    );
    const stationId = waiting.visit.currentStationId!;

    act(() => {
      const current = store.worklist(stationId).current;
      if (current) store.complete(current.visitId, CURRENT_USER);
      store.recall(waiting.visit.id, CURRENT_USER);
    });

    expect(screen.getByText(/it's your turn/i)).toBeDefined();
  });
});
