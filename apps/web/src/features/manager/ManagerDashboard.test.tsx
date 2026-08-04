import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { ManagerDashboard } from "./ManagerDashboard.js";
import { CURRENT_USER, ClinicStore } from "../../data/clinic-store.js";
import { STATIONS } from "../../data/demo-clinic.js";

describe("Manager Dashboard", () => {
  let store: ClinicStore;

  beforeEach(() => {
    store = new ClinicStore();
  });

  afterEach(cleanup);

  it("renders the control centre", () => {
    render(<ManagerDashboard store={store} />);
    expect(screen.getByRole("heading", { name: /operations/i })).toBeDefined();
  });

  /**
   * A control centre answers "what needs me now", so problems are stated before
   * totals — both in the layout and in what is emphasised.
   */
  it("leads with problems rather than totals", () => {
    render(<ManagerDashboard store={store} />);
    const needsAttention = screen.queryByRole("heading", {
      name: /needs attention|within target/i,
    });
    const totals = screen.getByText(/patients waiting/i);
    expect(needsAttention).not.toBeNull();
    // The attention panel appears earlier in document order than the totals.
    expect(
      needsAttention!.compareDocumentPosition(totals) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  /**
   * The dashboard identifies a case by station and ticket, never by name. It is
   * read on a large screen in an open office; identity belongs one click away in
   * the station workspace, behind that station's permissions.
   */
  it("identifies the longest wait by station and ticket, not by patient", () => {
    render(<ManagerDashboard store={store} />);
    const longest = store.longestWaiting(new Date())!;
    expect(longest).toBeDefined();

    const card = screen
      .getByRole("heading", { name: /longest wait/i })
      .closest("section")!;
    expect(within(card).getByText(longest.item.entry.queueLabel)).toBeDefined();
    expect(within(card).queryByText(longest.item.patientName)).toBeNull();
    expect(within(card).queryByText(longest.item.journeyCode)).toBeNull();
  });

  it("puts no patient name anywhere on the dashboard", () => {
    render(<ManagerDashboard store={store} />);
    for (const { visit } of store.visits) {
      expect(screen.queryByText(visit.patient.name)).toBeNull();
    }
  });

  it("reports totals that match the domain's own pulse", () => {
    const pulse = store.pulse(new Date());
    render(<ManagerDashboard store={store} />);

    const waitingTile = screen
      .getByText(/patients waiting/i)
      .closest("article")!;
    expect(within(waitingTile).getByText(String(pulse.waiting))).toBeDefined();

    const servedTile = screen.getByText(/being served/i).closest("article")!;
    expect(within(servedTile).getByText(String(pulse.beingServed))).toBeDefined();
  });

  it("shows a queue meter per station", () => {
    render(<ManagerDashboard store={store} />);
    for (const name of ["Consultation", "Laboratory", "Pharmacy", "Vitals"]) {
      expect(
        screen.getByRole("meter", {
          name: new RegExp(`${name} queue length`, "i"),
        }),
      ).toBeDefined();
    }
  });

  it("lists staff workload without ranking anyone as best", () => {
    render(<ManagerDashboard store={store} />);
    const card = screen
      .getByRole("heading", { name: /staff workload/i })
      .closest("section")!;
    // Throughput is reported; the card explicitly disclaims it as a ranking.
    expect(within(card).getByText(/not a ranking/i)).toBeDefined();
    expect(within(card).getByText(/case mix/i)).toBeDefined();
  });

  it("updates live when a station acts, with no refresh", () => {
    render(<ManagerDashboard store={store} />);
    const before = store.pulse(new Date()).beingServed;

    act(() => {
      store.callNext(STATIONS.pharmacy, CURRENT_USER);
    });

    const servedTile = screen.getByText(/being served/i).closest("article")!;
    expect(
      within(servedTile).getByText(String(before + 1)),
    ).toBeDefined();
  });

  it("says so plainly when every station is within target", () => {
    // Clear every queue. A queued visit must be called before it can be
    // completed — the state machine allows no shortcut — so do both, and assert
    // each step landed rather than letting a silent refusal pass as success.
    for (const worklist of store.allWorklists()) {
      for (const item of [...worklist.waiting, ...(worklist.current ? [worklist.current] : [])]) {
        store.recall(item.visitId, CURRENT_USER);
        expect(store.complete(item.visitId, CURRENT_USER).ok).toBe(true);
      }
    }
    expect(store.pulse(new Date()).waiting).toBe(0);

    render(<ManagerDashboard store={store} />);
    expect(
      screen.getByRole("heading", { name: /every station is within target/i }),
    ).toBeDefined();
  });
});
