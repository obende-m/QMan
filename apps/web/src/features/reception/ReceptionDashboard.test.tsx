import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ReceptionDashboard } from "./ReceptionDashboard.js";
import { CURRENT_USER, ClinicStore } from "../../data/clinic-store.js";
import { STATIONS } from "../../data/demo-clinic.js";

/**
 * These assertions matter more than they look. The demo clinic drives every
 * visit through the real `Visit` aggregate — create, enqueue, call, start,
 * route — so if any of those transitions were illegal, building the store would
 * throw before a single element rendered. The screen is therefore a live check
 * that the domain engine and the UI agree.
 */
describe("Reception Dashboard", () => {
  let store: ClinicStore;

  // A fresh clinic per test: the aggregates are mutable, so a shared store
  // would leak one test's actions into the next.
  beforeEach(() => {
    store = new ClinicStore();
  });

  // Testing Library only auto-cleans when Vitest runs with `globals: true`.
  afterEach(cleanup);

  it("renders without the domain engine rejecting any transition", () => {
    render(<ReceptionDashboard store={store} />);
    expect(
      screen.getByRole("heading", { name: /reception dashboard/i }),
    ).toBeDefined();
  });

  it("shows a live queue card per active station", () => {
    render(<ReceptionDashboard store={store} />);
    for (const name of ["Vitals", "Consultation", "Laboratory"]) {
      expect(
        screen.getByRole("meter", { name: new RegExp(`^${name} queue`, "i") }),
      ).toBeDefined();
    }
  });

  it("reports queue depths that match the domain's own worklist", () => {
    render(<ReceptionDashboard store={store} />);
    const expected = store.worklist(STATIONS.consultation).counts.waiting;
    const meter = screen.getByRole("meter", { name: /consultation queue/i });
    expect(meter.getAttribute("aria-valuenow")).toBe(String(expected));
  });

  it("keeps Recent Visits chronological", () => {
    render(<ReceptionDashboard store={store} />);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(7); // six visits plus the header

    const expectedOrder = [...store.visits]
      .sort((a, b) => b.arrivedAt.getTime() - a.arrivedAt.getTime())
      .slice(0, 6)
      .map(({ visit }) => visit.patient.name);

    const rendered = rows
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[1]!.textContent ?? "");

    expectedOrder.forEach((name, index) => {
      expect(rendered[index]).toContain(name);
    });
  });

  it("renders every recent visit with its journey code", () => {
    render(<ReceptionDashboard store={store} />);
    const table = screen.getByRole("table");
    for (const row of within(table).getAllByRole("row").slice(1)) {
      expect(row.textContent).toMatch(/QM-[0-9A-Z]{4}/);
    }
  });

  it("flags a non-normal priority on the rows that carry one", () => {
    render(<ReceptionDashboard store={store} />);
    const table = screen.getByRole("table");
    // Normal priority renders no chip, by design — a chip on every row would be
    // noise. So assert on a patient who does carry one.
    expect(within(table).getAllByText("VIP").length).toBeGreaterThan(0);
  });
});

/**
 * The section that resolves the finding recorded against the original design:
 * Recent Visits stays chronological, and clinical urgency gets a home that
 * arrival order cannot push a patient out of.
 */
describe("Priority Patients", () => {
  let store: ClinicStore;

  beforeEach(() => {
    store = new ClinicStore();
  });

  afterEach(cleanup);

  it("surfaces an emergency patient who is too old to appear in Recent Visits", () => {
    render(<ReceptionDashboard store={store} />);

    const emergency = store.visits.find(
      ({ visit }) => visit.priority === "emergency",
    );
    expect(emergency).toBeDefined();

    // Absent from the chronological table…
    const table = screen.getByRole("table");
    expect(within(table).queryByText(emergency!.visit.patient.name)).toBeNull();

    // …but present in Priority Patients.
    const section = screen
      .getByRole("heading", { name: /priority patients/i })
      .closest("section")!;
    expect(
      within(section).getByText(emergency!.visit.patient.name),
    ).toBeDefined();
  });

  it("includes High priority and excludes VIP", () => {
    render(<ReceptionDashboard store={store} />);
    const section = screen
      .getByRole("heading", { name: /priority patients/i })
      .closest("section")!;

    // VIP is a commercial courtesy tier, not clinical urgency (ADR-006), so it
    // must not appear in a band staff read as "urgent".
    expect(within(section).queryByText("VIP")).toBeNull();
    expect(within(section).getAllByText("Urgent").length).toBeGreaterThan(0);
    expect(within(section).getAllByText("Emergency").length).toBeGreaterThan(0);
  });

  it("orders emergency above high, then by longest wait", () => {
    render(<ReceptionDashboard store={store} />);
    const ordered = store.priorityVisits();
    expect(ordered[0]!.visit.priority).toBe("emergency");

    const section = screen
      .getByRole("heading", { name: /priority patients/i })
      .closest("section")!;
    const items = within(section).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain(ordered[0]!.visit.patient.name);
  });

  it("drops a patient from the list once their visit completes", () => {
    const urgent = store
      .priorityVisits()
      .find(({ visit }) => visit.status !== "completed");
    expect(urgent).toBeDefined();
    const before = store.priorityVisits().length;

    // Drive it to completion through the real aggregate. A queued visit must be
    // called before it can be completed — the state machine allows no shortcut.
    if (urgent!.visit.status === "queued") {
      store.recall(urgent!.visit.id, CURRENT_USER);
    }
    expect(store.complete(urgent!.visit.id, CURRENT_USER).ok).toBe(true);

    expect(store.priorityVisits().length).toBeLessThan(before);
  });

  it("shows a reassuring empty state when nobody is urgent", () => {
    // De-escalate everyone, then confirm the section says so rather than
    // rendering an empty box.
    for (const { visit } of store.priorityVisits()) {
      store.escalate(visit.id, "normal", null, CURRENT_USER);
    }
    render(<ReceptionDashboard store={store} />);
    expect(
      screen.getByText(/no emergency or urgent patients waiting/i),
    ).toBeDefined();
  });
});
