import { describe, expect, it } from "vitest";
import {
  QUEUE_NUMBER_PRESETS,
  assertQueueNumberConfig,
  formatQueueNumber,
  issueTicket,
  validateQueueNumberConfig,
  type QueueNumberConfig,
} from "./queue-number.js";
import { parseJourneyCode } from "../journey/journey-code.js";
import { ValidationError } from "../shared/errors.js";

const context = (ordinal: number, stationCode = "LAB") => ({
  ordinal,
  stationCode,
  journeyCode: parseJourneyCode("QM-8F4K"),
  issuedAt: new Date("2026-03-09T09:15:00.000Z"),
});

describe("queue number formats", () => {
  it("renders the sequential preset the way a hospital writes it", () => {
    const config = QUEUE_NUMBER_PRESETS.sequential("A");
    expect(formatQueueNumber(config, context(1))).toBe("A-001");
    expect(formatQueueNumber(config, context(42))).toBe("A-042");
    expect(formatQueueNumber(config, context(7))).toBe("A-007");
  });

  it("renders the department-prefix preset from the station's own code", () => {
    // One configuration serves every station, because the prefix is a token.
    const config = QUEUE_NUMBER_PRESETS.departmentPrefix();
    expect(formatQueueNumber(config, context(4, "LAB"))).toBe("LAB-004");
    expect(formatQueueNumber(config, context(4, "OPD"))).toBe("OPD-004");
    expect(formatQueueNumber(config, context(4, "PHARM"))).toBe("PHARM-004");
  });

  it("renders the numeric-only preset", () => {
    expect(formatQueueNumber(QUEUE_NUMBER_PRESETS.numeric(), context(12))).toBe(
      "012",
    );
  });

  it("can call patients by Journey Code instead of issuing a ticket", () => {
    const config = QUEUE_NUMBER_PRESETS.journeyCode();
    expect(formatQueueNumber(config, context(99))).toBe("QM-8F4K");
    // Nothing to reset when the label is the visit's permanent identity.
    expect(config.reset).toBe("never");
  });

  it("supports a format nobody anticipated, with no code change", () => {
    const config: QueueNumberConfig = {
      template: "{station}/{yyyy}{mm}{dd}/{n:4}",
      reset: "daily",
    };
    expect(formatQueueNumber(config, context(83, "RAD"))).toBe(
      "RAD/20260309/0083",
    );
  });

  it("leaves an unpadded ordinal alone", () => {
    expect(
      formatQueueNumber({ template: "#{n}", reset: "daily" }, context(7)),
    ).toBe("#7");
  });

  it("does not truncate an ordinal that outgrows its padding", () => {
    // Better to print a wider ticket than to call two patients "001".
    expect(
      formatQueueNumber({ template: "A-{n:3}", reset: "daily" }, context(1234)),
    ).toBe("A-1234");
  });

  it("leaves an unknown token visible rather than guessing", () => {
    // A silent substitution would print a plausible but wrong ticket.
    expect(
      formatQueueNumber({ template: "{ward}-{n:3}", reset: "daily" }, context(1)),
    ).toBe("{ward}-001");
  });
});

describe("queue number configuration validation", () => {
  it("accepts every preset", () => {
    expect(validateQueueNumberConfig(QUEUE_NUMBER_PRESETS.sequential("A"))).toEqual([]);
    expect(validateQueueNumberConfig(QUEUE_NUMBER_PRESETS.departmentPrefix())).toEqual([]);
    expect(validateQueueNumberConfig(QUEUE_NUMBER_PRESETS.numeric())).toEqual([]);
    expect(validateQueueNumberConfig(QUEUE_NUMBER_PRESETS.journeyCode())).toEqual([]);
  });

  it("rejects an empty template", () => {
    expect(
      validateQueueNumberConfig({ template: "   ", reset: "daily" }),
    ).toContain("A queue number template cannot be empty.");
  });

  it("rejects a template that would give every patient the same ticket", () => {
    const problems = validateQueueNumberConfig({
      template: "LAB",
      reset: "daily",
    });
    expect(problems.join(" ")).toMatch(/must include \{n\} or \{journey\}/);
  });

  it("names the unknown token and lists the valid ones", () => {
    const problems = validateQueueNumberConfig({
      template: "{ward}-{n:3}",
      reset: "daily",
    });
    expect(problems.join(" ")).toMatch(/"\{ward\}" is not a known token/);
    expect(problems.join(" ")).toMatch(/\{station\}/);
  });

  it("throws for callers that cannot handle a problem list", () => {
    expect(() =>
      assertQueueNumberConfig({ template: "LAB", reset: "daily" }),
    ).toThrow(ValidationError);
  });
});

describe("issued tickets", () => {
  it("carries the ordinal, the label, and the period it belongs to", () => {
    const ticket = issueTicket(
      QUEUE_NUMBER_PRESETS.sequential("A"),
      context(3),
    );
    // The period is stored with the entry so a series can be rebuilt after a
    // restore without re-deriving it from configuration that may have changed.
    expect(ticket).toEqual({
      ordinal: 3,
      label: "A-003",
      periodKey: "2026-03-09",
    });
  });

  /**
   * The reason labels are stored on the queue entry rather than recomputed:
   * a patient holding a printed slip must still match the board after an
   * administrator changes the format mid-day.
   */
  it("is unaffected by a later change to the station's format", () => {
    const morning = issueTicket(QUEUE_NUMBER_PRESETS.sequential("A"), context(9));
    expect(morning.label).toBe("A-009");

    // Administrator switches the station to department prefixes at lunchtime.
    const afternoon = issueTicket(
      QUEUE_NUMBER_PRESETS.departmentPrefix(),
      context(10),
    );
    expect(afternoon.label).toBe("LAB-010");

    // The morning ticket is a stored value; it did not re-render.
    expect(morning.label).toBe("A-009");
  });
});
