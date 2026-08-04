import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANNOUNCEMENT_CONFIG,
  renderAnnouncement,
  validateAnnouncementConfig,
  type AnnouncementConfig,
  type AnnouncementContext,
} from "./announcement.js";
import { parseJourneyCode } from "../journey/journey-code.js";

const context = (
  overrides: Partial<AnnouncementContext> = {},
): AnnouncementContext => ({
  ticket: "A-023",
  journeyCode: parseJourneyCode("QM-8F4K"),
  patientName: "Amara Okafor",
  stationName: "Consultation",
  room: "Room 2",
  hospitalName: "Ikeja General Hospital",
  namePolicy: "ticket_only",
  ...overrides,
});

const withTemplate = (template: string): AnnouncementConfig => ({
  ...DEFAULT_ANNOUNCEMENT_CONFIG,
  templates: { ...DEFAULT_ANNOUNCEMENT_CONFIG.templates, called: template },
});

describe("announcement rendering", () => {
  it("speaks the default call announcement", () => {
    expect(
      renderAnnouncement(DEFAULT_ANNOUNCEMENT_CONFIG, "called", context()),
    ).toBe("Ticket A-023, please proceed to Consultation, Room 2.");
  });

  it("can call by journey code instead of ticket", () => {
    expect(
      renderAnnouncement(
        withTemplate("Journey {journey}, please proceed to {station}."),
        "called",
        context(),
      ),
    ).toBe("Journey QM-8F4K, please proceed to Consultation.");
  });

  it("marks a recall so patients know they missed the first call", () => {
    expect(
      renderAnnouncement(DEFAULT_ANNOUNCEMENT_CONFIG, "recalled", context()),
    ).toMatch(/^Repeat\./);
  });

  /**
   * Announcements are spoken aloud in a public room, so they obey the same name
   * policy as the display board rather than having a switch of their own.
   */
  it("respects the name policy", () => {
    const template = withTemplate("{name}, please proceed to {station}.");

    expect(renderAnnouncement(template, "called", context({ namePolicy: "full_name" })))
      .toBe("Amara Okafor, please proceed to Consultation.");

    expect(
      renderAnnouncement(template, "called", context({ namePolicy: "first_name" })),
    ).toBe("Amara, please proceed to Consultation.");
  });

  it("falls back to the ticket rather than leaving a hole in the sentence", () => {
    // A hospital that adds {name} under a ticket-only policy must still get a
    // coherent announcement, not "please proceed, , to Room 2".
    expect(
      renderAnnouncement(
        withTemplate("{name}, please proceed to {station}."),
        "called",
        context({ namePolicy: "ticket_only" }),
      ),
    ).toBe("A-023, please proceed to Consultation.");
  });

  it("falls back to the station when a room is not configured", () => {
    expect(
      renderAnnouncement(
        DEFAULT_ANNOUNCEMENT_CONFIG,
        "called",
        context({ room: null }),
      ),
    ).toBe("Ticket A-023, please proceed to Consultation, Consultation.");
  });

  it("tidies punctuation so the result still scans when spoken", () => {
    expect(
      renderAnnouncement(
        withTemplate("Ticket {ticket} , please proceed  to {station} ."),
        "called",
        context(),
      ),
    ).toBe("Ticket A-023, please proceed to Consultation.");
  });

  it("leaves an unknown token visible rather than guessing", () => {
    expect(
      renderAnnouncement(withTemplate("{ticket} to {ward}."), "called", context()),
    ).toBe("A-023 to {ward}.");
  });
});

describe("announcement configuration validation", () => {
  it("accepts the shipped default", () => {
    expect(validateAnnouncementConfig(DEFAULT_ANNOUNCEMENT_CONFIG)).toEqual([]);
  });

  /**
   * An announcement that names nobody calls everybody — every patient in the
   * room stands up.
   */
  it("rejects an announcement that identifies no one", () => {
    const problems = validateAnnouncementConfig(
      withTemplate("Please proceed to {station}."),
    );
    expect(problems.join(" ")).toMatch(/must include \{ticket\}, \{journey\} or \{name\}/);
  });

  it("rejects an empty announcement", () => {
    const problems = validateAnnouncementConfig(withTemplate("   "));
    expect(problems.join(" ")).toMatch(/cannot be empty/);
  });

  it("names an unknown token and lists the valid ones", () => {
    const problems = validateAnnouncementConfig(
      withTemplate("{ticket} to {ward}."),
    );
    expect(problems.join(" ")).toMatch(/"\{ward\}" is not a known token/);
    expect(problems.join(" ")).toMatch(/\{station\}/);
  });

  it("bounds the repeat count", () => {
    expect(
      validateAnnouncementConfig({ ...DEFAULT_ANNOUNCEMENT_CONFIG, repeat: 0 })
        .join(" "),
    ).toMatch(/between 1 and 3/);
    expect(
      validateAnnouncementConfig({ ...DEFAULT_ANNOUNCEMENT_CONFIG, repeat: 9 })
        .join(" "),
    ).toMatch(/between 1 and 3/);
  });

  it("requires a language for speech synthesis", () => {
    expect(
      validateAnnouncementConfig({ ...DEFAULT_ANNOUNCEMENT_CONFIG, language: " " })
        .join(" "),
    ).toMatch(/language is required/);
  });
});
