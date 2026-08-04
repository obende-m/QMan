import { displayPatientName, type PatientNamePolicy } from "../privacy/patient-name.js";
import { ValidationError } from "../shared/errors.js";
import type { JourneyCode } from "../journey/journey-code.js";

/**
 * Announcement templates.
 *
 * One rendered string drives the spoken announcement, the browser notification
 * body and the audit entry, so a patient hears, reads and can later verify
 * exactly the same words. Three separate strings would drift, and the drift
 * would surface as a patient insisting they were told something different.
 *
 * Templates are configuration for the same reason queue numbers are: a hospital
 * calling "Ticket A-023" and one calling "Journey QM-8F4K" are both right, and
 * neither should need a release.
 */

export const ANNOUNCEMENT_EVENTS = [
  "called",
  "recalled",
  "routed",
  "next_in_line",
  "completed",
] as const;

export type AnnouncementEvent = (typeof ANNOUNCEMENT_EVENTS)[number];

export interface AnnouncementConfig {
  /**
   * Tokens: {ticket} {journey} {name} {station} {room} {hospital}
   * e.g. "Ticket {ticket}, please proceed to {station}, {room}."
   */
  readonly templates: Readonly<Record<AnnouncementEvent, string>>;
  /** BCP-47 tag, e.g. "en-NG". Passed to speech synthesis. */
  readonly language: string;
  /** Preferred voice name; null lets the platform choose. */
  readonly voice: string | null;
  /** Attention chime played before the announcement. */
  readonly chime: "none" | "soft" | "bell";
  /** Times each announcement is spoken. Twice is common in noisy halls. */
  readonly repeat: number;
  readonly enabled: boolean;
}

export const DEFAULT_ANNOUNCEMENT_CONFIG: AnnouncementConfig = {
  templates: {
    called: "Ticket {ticket}, please proceed to {station}, {room}.",
    recalled: "Repeat. Ticket {ticket}, please proceed to {station}, {room}.",
    routed: "Ticket {ticket}, your visit has been routed to {station}.",
    next_in_line: "Ticket {ticket}, you are next in line for {station}.",
    completed: "Ticket {ticket}, your visit is complete. Thank you.",
  },
  language: "en-GB",
  voice: null,
  chime: "soft",
  repeat: 1,
  enabled: true,
};

export interface AnnouncementContext {
  readonly ticket: string;
  readonly journeyCode: JourneyCode;
  readonly patientName: string;
  readonly stationName: string;
  readonly room: string | null;
  readonly hospitalName: string;
  /**
   * Governs whether {name} renders. Announcements are spoken aloud in a public
   * room, so they are bound by the same policy as the display board rather than
   * having a switch of their own.
   */
  readonly namePolicy: PatientNamePolicy;
}

const TOKEN = /\{(\w+)\}/g;

export function renderAnnouncement(
  config: AnnouncementConfig,
  event: AnnouncementEvent,
  context: AnnouncementContext,
): string {
  const template = config.templates[event];

  const rendered = template.replace(TOKEN, (match, name: string) => {
    switch (name) {
      case "ticket":
        return context.ticket;
      case "journey":
        return context.journeyCode;
      case "name":
        // Falls back to the ticket rather than leaving a hole in the sentence,
        // so a hospital that adds {name} under a ticket-only policy still gets
        // a coherent announcement instead of "please proceed, , to Room 2".
        return (
          displayPatientName(context.patientName, context.namePolicy) ??
          context.ticket
        );
      case "station":
        return context.stationName;
      case "room":
        return context.room ?? context.stationName;
      case "hospital":
        return context.hospitalName;
      default:
        return match;
    }
  });

  // Collapse the double spaces and orphaned punctuation left when an optional
  // token renders empty — the result is spoken aloud, so it has to scan.
  return rendered
    .replace(/\s+([,.])/g, "$1")
    .replace(/,\s*\./g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function validateAnnouncementConfig(
  config: AnnouncementConfig,
): string[] {
  const problems: string[] = [];
  const known = new Set([
    "ticket",
    "journey",
    "name",
    "station",
    "room",
    "hospital",
  ]);

  for (const event of ANNOUNCEMENT_EVENTS) {
    const template = config.templates[event];
    if (!template || template.trim().length === 0) {
      problems.push(`The "${event}" announcement cannot be empty.`);
      continue;
    }

    let identifies = false;
    for (const match of template.matchAll(TOKEN)) {
      const name = match[1]!;
      if (!known.has(name)) {
        problems.push(
          `"{${name}}" is not a known token. Available: ${[...known]
            .map((t) => `{${t}}`)
            .join(", ")}.`,
        );
      }
      if (name === "ticket" || name === "journey" || name === "name") {
        identifies = true;
      }
    }

    // An announcement that names nobody calls everybody.
    if (!identifies) {
      problems.push(
        `The "${event}" announcement must include {ticket}, {journey} or {name}, otherwise no patient knows it is for them.`,
      );
    }
  }

  if (config.repeat < 1 || config.repeat > 3) {
    problems.push("Announcements may be repeated between 1 and 3 times.");
  }

  if (config.language.trim().length === 0) {
    problems.push("A language is required for spoken announcements.");
  }

  return problems;
}
