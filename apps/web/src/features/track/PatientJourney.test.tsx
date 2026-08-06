import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PatientJourney } from "./PatientJourney.js";
import type { Visit } from "@qman/domain";
import type { ClinicStore } from "../../data/clinic-store.js";
import {
  createFixture,
  STATION_IDS as STATIONS,
  USER_ID,
  type Fixture,
} from "../../test/api-fixture.js";

describe("Patient Journey Tracking", () => {
  let fixture: Fixture;
  let store: ClinicStore;
  let waiting: Visit;

  beforeEach(async () => {
    fixture = await createFixture();
    store = fixture.clinic;
    // A patient who is queued and not yet called — the common case.
    waiting = store.visits.find((visit) => visit.status === "queued")!;
  });

  afterEach(() => {
    fixture.restore();
    cleanup();
  });

  it("asks for a journey code and needs no account", async () => {
    render(<PatientJourney store={store} />);
    expect(screen.getByLabelText(/journey code/i)).toBeDefined();
    expect(screen.getByText(/no account needed/i)).toBeDefined();
  });

  it("finds a visit from a code typed however the patient managed it", async () => {
    render(<PatientJourney store={store} />);
    const code = waiting.journeyCode;

    fireEvent.change(screen.getByLabelText(/journey code/i), {
      // Lower case, no prefix, stray spaces — all should resolve.
      target: { value: ` ${code.replace("QM-", "").toLowerCase()} ` },
    });
    fireEvent.click(screen.getByRole("button", { name: /track my visit/i }));

    expect(screen.getByText(waiting.patient.name)).toBeDefined();
  });

  it("explains itself when the code is wrong instead of failing silently", async () => {
    render(<PatientJourney store={store} />);
    fireEvent.change(screen.getByLabelText(/journey code/i), {
      target: { value: "QM-ZZZZ" },
    });
    fireEvent.click(screen.getByRole("button", { name: /track my visit/i }));

    const error = screen.getByRole("alert");
    expect(error.textContent).toMatch(/couldn't find that code/i);
    expect(error.textContent).toMatch(/ask at reception/i);
  });

  it("opens straight onto the journey when arrived at by QR", async () => {
    render(
      <PatientJourney store={store} initialCode={waiting.journeyCode} />,
    );
    expect(screen.getByText(waiting.patient.name)).toBeDefined();
    expect(screen.queryByLabelText(/journey code/i)).toBeNull();
  });

  it("shows position, people ahead, estimated wait, ticket and room", async () => {
    render(
      <PatientJourney store={store} initialCode={waiting.journeyCode} />,
    );

    const position = store.positionOf(waiting.id)!;
    const ahead = store.aheadOf(waiting.id)!;

    expect(screen.getByText(`#${position}`)).toBeDefined();
    expect(screen.getByText(/estimated wait/i)).toBeDefined();
    expect(
      screen.getByText(waiting.currentEntry!.queueLabel),
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
  it("keeps the ticket fixed while the position counts down", async () => {
    render(
      <PatientJourney store={store} initialCode={waiting.journeyCode} />,
    );

    const stationId = waiting.currentStationId!;
    const ticket = waiting.currentEntry!.queueLabel;
    const positionBefore = store.positionOf(waiting.id)!;

    // Clear the patient ahead of them so the queue advances.
    act(() => {
      const current = store.worklist(stationId).current;
      if (current) store.complete(current.visitId, USER_ID);
      const next = store.worklist(stationId).waiting[0];
      if (next && next.visitId !== waiting.id) {
        store.callNext(stationId, USER_ID);
        store.complete(next.visitId, USER_ID);
      }
    });

    const positionAfter = store.positionOf(waiting.id);
    if (positionAfter !== null && positionBefore > 1) {
      expect(positionAfter).toBeLessThan(positionBefore);
    }
    // The ticket did not change with it.
    expect(waiting.currentEntry!.queueLabel).toBe(ticket);
  });

  it("tells the patient plainly when it is their turn", async () => {
    const stationId = waiting.currentStationId!;
    // Clear the station, then call this patient up.
    const current = store.worklist(stationId).current;
    if (current) store.complete(current.visitId, USER_ID);
    store.recall(waiting.id, USER_ID);

    render(
      <PatientJourney store={store} initialCode={waiting.journeyCode} />,
    );

    expect(screen.getByText(/it's your turn/i)).toBeDefined();
    expect(screen.getByText(/please go to/i)).toBeDefined();
  });

  it("closes the loop when the visit is complete", async () => {
    const done = store.visits.find((visit) => visit.status === "completed")!;
    render(<PatientJourney store={store} initialCode={done.journeyCode} />);
    expect(screen.getByText(/your visit is complete/i)).toBeDefined();
    expect(screen.getByText(/you may now leave/i)).toBeDefined();
  });

  it("shows the journey timeline, including what is still ahead", async () => {
    render(
      <PatientJourney store={store} initialCode={waiting.journeyCode} />,
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
  it("says it is live while the source keeps reporting", async () => {
    render(
      <PatientJourney store={store} initialCode={waiting.journeyCode} />,
    );
    expect(screen.getByText("Live")).toBeDefined();
    expect(screen.queryByText(/may be out of date/i)).toBeNull();
  });

  it("casts doubt on the numbers once it stops receiving updates", async () => {
    vi.useFakeTimers();
    try {
      render(
        <PatientJourney store={store} initialCode={waiting.journeyCode} />,
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
        <PatientJourney store={store} initialCode={waiting.journeyCode} />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      // Something labelled as possibly out of date beats a blank screen.
      expect(screen.getByText(waiting.journeyCode)).toBeDefined();
      expect(screen.getByLabelText(/your position/i)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers as soon as the source reports again", async () => {
    vi.useFakeTimers();
    try {
      render(
        <PatientJourney store={store} initialCode={waiting.journeyCode} />,
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

  it("updates live as the clinic moves", async () => {
    render(
      <PatientJourney store={store} initialCode={waiting.journeyCode} />,
    );
    const stationId = waiting.currentStationId!;

    act(() => {
      const current = store.worklist(stationId).current;
      if (current) store.complete(current.visitId, USER_ID);
      store.recall(waiting.id, USER_ID);
    });

    expect(screen.getByText(/it's your turn/i)).toBeDefined();
  });
});
