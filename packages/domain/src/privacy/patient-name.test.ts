import { describe, expect, it } from "vitest";
import {
  DEFAULT_PATIENT_NAME_POLICY,
  displayPatientName,
  describeNamePolicy,
} from "./patient-name.js";

describe("patient name policy", () => {
  it("shows nothing by default", () => {
    expect(DEFAULT_PATIENT_NAME_POLICY).toBe("ticket_only");
    expect(displayPatientName("Amara Okafor", "ticket_only")).toBeNull();
  });

  it("shows only the first name when configured", () => {
    expect(displayPatientName("Amara Okafor", "first_name")).toBe("Amara");
    expect(displayPatientName("Grace Adaeze Mensah", "first_name")).toBe("Grace");
  });

  it("shows the whole name when a clinic opts in", () => {
    expect(displayPatientName("Amara Okafor", "full_name")).toBe("Amara Okafor");
  });

  it("handles a mononym without rendering blank", () => {
    // Single-token names are common across QMan's markets; first-name policy
    // must not silently produce an empty label.
    expect(displayPatientName("Adaeze", "first_name")).toBe("Adaeze");
  });

  it("returns null rather than an empty string for a blank name", () => {
    // Forces callers to handle absence instead of rendering whitespace.
    expect(displayPatientName("   ", "full_name")).toBeNull();
    expect(displayPatientName("", "first_name")).toBeNull();
  });

  it("collapses irregular spacing", () => {
    expect(displayPatientName("  Amara   Okafor  ", "first_name")).toBe("Amara");
    expect(displayPatientName("  Amara Okafor  ", "full_name")).toBe(
      "Amara Okafor",
    );
  });

  it("describes each policy for the administration UI", () => {
    expect(describeNamePolicy("ticket_only")).toMatch(/ticket number only/i);
    expect(describeNamePolicy("first_name")).toMatch(/first name/i);
    expect(describeNamePolicy("full_name")).toMatch(/full name/i);
  });
});
