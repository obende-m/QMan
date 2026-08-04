import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import type { StationId } from "@qman/domain";
import { StationWorkspace } from "./StationWorkspace.js";
import { AnnouncerProvider } from "../../components/ui/Announcer.js";
import { CURRENT_USER, ClinicStore } from "../../data/clinic-store.js";
import { STATIONS, workspaceStations } from "../../data/demo-clinic.js";

function renderWorkspace(stationId: StationId, store: ClinicStore): void {
  render(
    (
      <AnnouncerProvider>
        <StationWorkspace stationId={stationId} store={store} />
      </AnnouncerProvider>
    ) as ReactElement,
  );
}

describe("Station Workspace", () => {
  let store: ClinicStore;

  beforeEach(() => {
    store = new ClinicStore();
  });

  afterEach(cleanup);

  /**
   * The central claim of this component: it is not the Consultation screen, it
   * is *the* station screen. If any station needed special handling, one of
   * these renders would fail.
   */
  it("renders for every station type without station-specific code", () => {
    for (const stationId of workspaceStations()) {
      renderWorkspace(stationId, store);
      expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
      cleanup();
    }
  });

  it("adapts its vocabulary to the station", () => {
    // Consultation has a patient in progress in the seeded clinic.
    renderWorkspace(STATIONS.consultation, store);
    expect(screen.getByText(/time in consult/i)).toBeDefined();
    cleanup();

    // Pharmacy starts clear, so call someone up before the timer exists.
    store.callNext(STATIONS.pharmacy, CURRENT_USER);
    renderWorkspace(STATIONS.pharmacy, store);
    expect(screen.getByText(/time at counter/i)).toBeDefined();
    expect(screen.getByText(/start dispensing/i)).toBeDefined();
  });

  it("works for a station that has no profile at all", () => {
    // An administrator created this five minutes ago. It must still function,
    // falling back to generic wording.
    const dialysis = "st-dialysis" as StationId;
    renderWorkspace(dialysis, store);
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.getByText(/nobody is waiting at this station/i)).toBeDefined();
  });

  it("offers destinations from the workflow, not a hardcoded list", () => {
    renderWorkspace(STATIONS.consultation, store);
    // The workflow allows Consultation → Laboratory (next) and → Pharmacy is
    // not directly reachable, so it must not be offered.
    const sendTo = screen.getByText(/^send to$/i).parentElement!;
    expect(within(sendTo).getByRole("button", { name: /laboratory/i })).toBeDefined();
    expect(within(sendTo).queryByRole("button", { name: /^vitals$/i })).toBeNull();
  });

  it("shows the journey code and the station queue number as different things", () => {
    renderWorkspace(STATIONS.consultation, store);
    expect(screen.getByText(/journey code/i)).toBeDefined();
    expect(screen.getByText(/queue number/i)).toBeDefined();
  });

  it("calls the next patient and shows them as now serving", () => {
    // Pharmacy is the one station that starts clear, so the call is real
    // rather than a no-op against an already-called patient.
    renderWorkspace(STATIONS.pharmacy, store);
    const waiting = store.worklist(STATIONS.pharmacy).waiting;
    expect(waiting.length).toBeGreaterThan(0);
    expect(store.worklist(STATIONS.pharmacy).current).toBeNull();

    // Both the header and the empty state offer the action.
    fireEvent.click(screen.getAllByRole("button", { name: /call next/i })[0]!);

    expect(store.worklist(STATIONS.pharmacy).current).not.toBeNull();
    expect(screen.getAllByText(waiting[0]!.patientName).length).toBeGreaterThan(0);
  });

  it("refuses to call next while a patient is still at the station", () => {
    // Consultation already has someone in progress in the seeded clinic.
    expect(store.worklist(STATIONS.consultation).current).not.toBeNull();
    const result = store.callNext(STATIONS.consultation, "user-doctor" as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/complete or route them first/i);
    }
  });

  it("turns an illegal domain action into a readable message, not a crash", () => {
    renderWorkspace(STATIONS.consultation, store);
    const current = store.worklist(STATIONS.consultation).current!;

    // Skipping is only legal for a patient who has been called, not one already
    // in progress. The engine rejects it; the screen must survive.
    const result = store.skip(current.visitId, null, "user-doctor" as never);
    expect(result.ok).toBe(false);
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
  });

  it("keeps a skipped patient in the queue with their place intact", () => {
    // Laboratory already has a called patient in the seeded clinic.
    renderWorkspace(STATIONS.laboratory, store);
    const called = store.worklist(STATIONS.laboratory).current!;
    expect(called.entry.status).toBe("called");
    const before = store.worklist(STATIONS.laboratory).counts.waiting;

    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));

    const after = store.worklist(STATIONS.laboratory);
    expect(after.current).toBeNull();
    // Back in the queue, not discarded.
    expect(after.counts.waiting).toBe(before + 1);
    expect(
      after.waiting.find((item) => item.visitId === called.visitId)?.entry.skipped,
    ).toBe(true);
  });

  it("routes a patient onward and clears the station", () => {
    renderWorkspace(STATIONS.laboratory, store);
    const current = store.worklist(STATIONS.laboratory).current!;

    const sendTo = screen.getByText(/^send to$/i).parentElement!;
    fireEvent.click(
      within(sendTo).getByRole("button", { name: /consultation/i }),
    );

    expect(store.worklist(STATIONS.laboratory).current).toBeNull();
    const moved = store.find(current.visitId)!;
    expect(moved.visit.currentStationId).toBe(STATIONS.consultation);
  });

  it("supports keyboard-first operation", () => {
    renderWorkspace(STATIONS.pharmacy, store);
    expect(store.worklist(STATIONS.pharmacy).current).toBeNull();

    fireEvent.keyDown(window, { key: "n" });
    expect(store.worklist(STATIONS.pharmacy).current).not.toBeNull();

    fireEvent.keyDown(window, { key: "s" });
    expect(store.worklist(STATIONS.pharmacy).current!.entry.status).toBe(
      "in_progress",
    );
  });

  it("ignores shortcuts while the user is typing", () => {
    renderWorkspace(STATIONS.pharmacy, store);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    fireEvent.keyDown(input, { key: "n" });
    expect(store.worklist(STATIONS.pharmacy).current).toBeNull();

    input.remove();
  });

  it("shows an actionable empty state when nobody has been called", () => {
    renderWorkspace(STATIONS.pharmacy, store);
    expect(screen.getByText(/nobody called yet/i)).toBeDefined();
  });

  it("does not invent clinical data it does not own", () => {
    renderWorkspace(STATIONS.consultation, store);
    // The PRD is explicit that medical records stay in the HMS. The workspace
    // leaves a labelled slot rather than fabricating vitals.
    expect(screen.getByText(/served from your HMS/i)).toBeDefined();
  });
});
