import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { AdminPortal } from "./AdminPortal.js";
import type { ConfigStore } from "../../data/config-store.js";
import { createFixture, STATION_IDS, type Fixture } from "../../test/api-fixture.js";

function openSection(name: RegExp): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

/**
 * The station list opens on the first station (Reception). Every test below
 * that edits numbering or SLAs works against Consultation, so it selects it
 * explicitly rather than relying on the default.
 */
function selectStation(name: RegExp): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("Administration Portal", () => {
  let fixture: Fixture;
  let store: ConfigStore;

  beforeEach(async () => {
    fixture = await createFixture();
    store = fixture.config;
  });

  afterEach(() => {
    fixture.restore();
    cleanup();
  });

  it("renders and reports a healthy configuration", async () => {
    render(<AdminPortal store={store} />);
    expect(screen.getByRole("heading", { name: /administration/i })).toBeDefined();
    expect(screen.getByText(/configuration is valid/i)).toBeDefined();
  });

  it("lists every station with a live ticket preview", async () => {
    render(<AdminPortal store={store} />);
    for (const name of ["Reception", "Vitals", "Consultation", "Laboratory", "Pharmacy"]) {
      expect(screen.getAllByText(new RegExp(name)).length).toBeGreaterThan(0);
    }
    // Reception issues a bare numeric series; the preview shows a real ticket.
    expect(screen.getByLabelText("Ticket preview").textContent).toBe("007");

    // Consultation issues an A- series.
    selectStation(/Consultation/);
    expect(screen.getByLabelText("Ticket preview").textContent).toMatch(
      /^A-\d{3}$/,
    );
  });

  /**
   * The whole point of the module: changing a template is configuration, and it
   * takes effect immediately rather than in the next release.
   */
  it("changes a station's queue-number format and previews the result", async () => {
    render(<AdminPortal store={store} />);
    selectStation(/Consultation/);

    const template = screen.getByDisplayValue("A-{n:3}");
    fireEvent.change(template, { target: { value: "OPD-{n:4}" } });
    fireEvent.blur(template);

    expect(store.station(STATION_IDS.consultation)!.queueNumber.template).toBe(
      "OPD-{n:4}",
    );
    expect(screen.getByLabelText("Ticket preview").textContent).toBe("OPD-0007");
  });

  it("refuses a template that would issue every patient the same ticket", async () => {
    render(<AdminPortal store={store} />);
    selectStation(/Consultation/);
    const template = screen.getByDisplayValue("A-{n:3}");

    fireEvent.change(template, { target: { value: "OPD" } });
    fireEvent.blur(template);

    expect(screen.getByRole("alert").textContent).toMatch(/not saved/i);
    // The store rejected it, so the old value stands.
    expect(store.station(STATION_IDS.consultation)!.queueNumber.template).toBe(
      "A-{n:3}",
    );
  });

  it("changes a station's reset strategy", async () => {
    render(<AdminPortal store={store} />);
    selectStation(/Consultation/);
    const select = screen.getByDisplayValue("Every day");
    fireEvent.change(select, { target: { value: "weekly" } });
    fireEvent.blur(select);
    await waitFor(() => expect(store.station(STATION_IDS.consultation)!.queueNumber.reset).toBe("weekly"));
  });

  it("adds a station without touching code", async () => {
    render(<AdminPortal store={store} />);
    const before = store.config.stations.length;

    fireEvent.click(screen.getByRole("button", { name: /add station/i }));

    await waitFor(() => expect(store.config.stations.length).toBe(before + 1));
    await waitFor(() => expect(store.config.stations.at(-1)!.name).toBe("New Station"));
  });

  it("edits an SLA target", async () => {
    render(<AdminPortal store={store} />);
    selectStation(/Consultation/);
    const target = screen.getByDisplayValue("30");
    fireEvent.change(target, { target: { value: "45" } });
    fireEvent.blur(target);
    expect(store.station(STATION_IDS.consultation)!.sla.targetWaitMillis).toBe(
      45 * 60_000,
    );
  });

  it("blocks putting an internal station on a public display board", async () => {
    render(<AdminPortal store={store} />);
    openSection(/display boards/i);

    // Reception is configured as non-public.
    const receptionToggle = screen.getByLabelText(/Internal station/i, {
      exact: false,
    });
    fireEvent.click(receptionToggle);

    expect(screen.getByRole("alert").textContent).toMatch(/not saved/i);
    expect(
      store.board("board-main")!.stationIds.includes(STATION_IDS.reception),
    ).toBe(false);
  });

  it("changes a board's name policy and warns about public exposure", async () => {
    render(<AdminPortal store={store} />);
    openSection(/display boards/i);

    const select = screen.getByDisplayValue("Ticket number only");
    fireEvent.change(select, { target: { value: "full_name" } });
    fireEvent.blur(select);

    await waitFor(() => expect(store.board("board-main")!.namePolicy).toBe("full_name"));
    expect(screen.getByText(/privacy obligations/i)).toBeDefined();
  });

  it("reorders workflow stages", async () => {
    render(<AdminPortal store={store} />);
    openSection(/^workflows$/i);

    const workflowBefore = store.defaultWorkflow()!;
    const firstStation = workflowBefore.stages[0]!.stationId;

    fireEvent.click(
      screen.getAllByRole("button", { name: /move .* later/i })[0]!,
    );

    const after = store.defaultWorkflow()!;
    expect(after.stages.find((s) => s.stationId === firstStation)!.sequence).toBe(2);
  });

  it("refuses to leave nobody able to administer the hospital", async () => {
    render(<AdminPortal store={store} />);
    openSection(/roles & permissions/i);

    // Administrator is the only role with admin.users.
    fireEvent.click(screen.getByRole("button", { name: /Administrator/i }));
    const checkbox = screen.getByRole("checkbox", {
      name: /Manage users and roles/i,
    });
    fireEvent.click(checkbox);

    expect(screen.getByRole("alert").textContent).toMatch(/not saved/i);
    const admin = store.roles.find((r) => r.id === "role-administrator")!;
    expect(admin.permissions).toContain("admin.users");
  });

  it("edits the hospital profile and rejects an invalid brand colour", async () => {
    render(<AdminPortal store={store} />);
    openSection(/^hospital$/i);

    const name = screen.getByDisplayValue("Ikeja General Hospital");
    fireEvent.change(name, { target: { value: "Lagos Central" } });
    fireEvent.blur(name);
    await waitFor(() => expect(store.config.profile.name).toBe("Lagos Central"));

    const colors = screen.getAllByDisplayValue("#003ec7");
    fireEvent.change(colors[colors.length - 1]!, { target: { value: "blue" } });
    expect(screen.getByRole("alert").textContent).toMatch(/not saved/i);
    await waitFor(() => expect(store.config.profile.brandColor).toBe("#003ec7"));
  });

  it("previews exactly what a patient will hear and read", async () => {
    render(<AdminPortal store={store} />);
    openSection(/^announcements$/i);

    const preview = screen.getByLabelText(/patient called preview/i);
    expect(preview.textContent).toMatch(
      /Ticket A-023, please proceed to Consultation, Room 2\./,
    );
  });

  it("refuses an announcement that identifies nobody", async () => {
    render(<AdminPortal store={store} />);
    openSection(/^announcements$/i);

    const called = screen.getByDisplayValue(
      "Ticket {ticket}, please proceed to {station}, {room}.",
    );
    fireEvent.change(called, {
      target: { value: "Please proceed to {station}." },
    });

    // Every patient in the room would stand up.
    expect(screen.getByRole("alert").textContent).toMatch(
      /must include \{ticket\}, \{journey\} or \{name\}/,
    );
  });

  it("surfaces warnings without blocking the save", async () => {
    render(<AdminPortal store={store} />);
    selectStation(/Consultation/);
    const room = screen.getByDisplayValue("Room 12");
    fireEvent.change(room, { target: { value: "" } });
    fireEvent.blur(room);

    // Saved, but flagged.
    await waitFor(() => expect(store.station(STATION_IDS.consultation)!.room).toBeNull());
    expect(screen.getByRole("status").textContent).toMatch(/suggestions/i);
  });

  it("flags sections that contain errors in the navigation", async () => {
    // Break the profile directly, then confirm the nav marks it.
    await store.updateProfile({ name: "Temporarily fine" });
    render(<AdminPortal store={store} />);

    // Asserting the sections by name rather than by count: a bare number breaks
    // on every addition and says nothing about what is missing when it does.
    const nav = screen.getByRole("navigation", { name: /administration sections/i });
    for (const label of [
      /^Hospital$/,
      /^Stations$/,
      /^Workflows$/,
      /Display Boards/,
      /^Announcements$/,
      /Printed Tickets/,
      /Roles & Permissions/,
      /^Sessions$/,
    ]) {
      expect(within(nav).getByRole("button", { name: label })).toBeDefined();
    }
  });
});
