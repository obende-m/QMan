import { displayPatientName, type PatientNamePolicy } from "../privacy/patient-name.js";
import type { JourneyCode } from "../journey/journey-code.js";

/**
 * Printed ticket templates.
 *
 * A hospital's printer is not a detail QMan gets to choose. A 58 mm thermal
 * roll at reception, an 80 mm roll at triage and an A4 sheet in a consulting
 * room are all real, and a single hardcoded layout would be wrong on two of the
 * three. So the ticket is a template — paper size, which elements appear, and
 * the wording around them — configured per hospital rather than per release.
 *
 * The element list is closed rather than free-form. A ticket is the one artefact
 * a patient carries out of the building; letting an administrator compose
 * arbitrary layouts invites a ticket with no journey code on it, which breaks
 * tracking silently and is discovered at the worst moment.
 */

export const PAPER_SIZES = ["thermal_58mm", "thermal_80mm", "a4", "label_62mm"] as const;

export type PaperSize = (typeof PAPER_SIZES)[number];

export interface PaperSpec {
  readonly label: string;
  /** Printable width in millimetres. */
  readonly widthMm: number;
  /** Fixed height, or null for a continuous roll that grows to fit. */
  readonly heightMm: number | null;
  readonly marginMm: number;
  /** Base font size in points, tuned to the width. */
  readonly baseFontPt: number;
}

export const PAPER_SPECS: Readonly<Record<PaperSize, PaperSpec>> = {
  // Thermal rolls quote their paper width; the printable area is narrower.
  thermal_58mm: {
    label: "58 mm thermal roll",
    widthMm: 48,
    heightMm: null,
    marginMm: 3,
    baseFontPt: 9,
  },
  thermal_80mm: {
    label: "80 mm thermal roll",
    widthMm: 72,
    heightMm: null,
    marginMm: 4,
    baseFontPt: 10,
  },
  a4: {
    label: "A4 sheet",
    widthMm: 210,
    heightMm: 297,
    marginMm: 18,
    baseFontPt: 11,
  },
  label_62mm: {
    label: "62 mm label",
    widthMm: 58,
    heightMm: 90,
    marginMm: 3,
    baseFontPt: 9,
  },
};

/** Everything that may appear on a ticket. Closed set, deliberately. */
export const TICKET_ELEMENTS = [
  "logo",
  "hospitalName",
  "branch",
  "queueTicket",
  "journeyCode",
  "qrCode",
  "visitTime",
  "station",
  "room",
  "doctor",
  "patientName",
  "instructions",
  "footer",
] as const;

export type TicketElement = (typeof TICKET_ELEMENTS)[number];

export const TICKET_ELEMENT_LABELS: Readonly<Record<TicketElement, string>> = {
  logo: "Hospital logo",
  hospitalName: "Hospital name",
  branch: "Branch",
  queueTicket: "Queue ticket number",
  journeyCode: "Journey code",
  qrCode: "QR code",
  visitTime: "Visit time",
  station: "Assigned station",
  room: "Room",
  doctor: "Assigned clinician",
  patientName: "Patient name",
  instructions: "Instructions",
  footer: "Footer message",
};

/**
 * When an element actually prints.
 *
 * Conditions keep a ticket compact without needing a separate template for
 * every small variation. A single-branch hospital should not print a branch
 * line on every ticket; a patient with no clinician assigned yet should not get
 * an empty "Doctor:" row.
 */
export const ELEMENT_CONDITIONS = [
  "always",
  "if_present",
  "if_multiple_branches",
] as const;

export type ElementCondition = (typeof ELEMENT_CONDITIONS)[number];

export const CONDITION_LABELS: Readonly<Record<ElementCondition, string>> = {
  always: "Always print",
  if_present: "Only when known",
  if_multiple_branches: "Only with multiple branches",
};

export interface TicketElementSpec {
  readonly element: TicketElement;
  readonly condition: ElementCondition;
}

/** Sensible default for each element, used when one is first added. */
export function defaultConditionFor(element: TicketElement): ElementCondition {
  switch (element) {
    case "branch":
      return "if_multiple_branches";
    case "room":
    case "doctor":
    case "logo":
    case "instructions":
      return "if_present";
    default:
      return "always";
  }
}

export interface TicketTemplate {
  readonly id: string;
  readonly name: string;
  readonly paper: PaperSize;
  /** Elements to print, in the order given, each with its own condition. */
  readonly elements: readonly TicketElementSpec[];
  /**
   * Free text shown under the ticket. Supports the same tokens as the ticket
   * body: {ticket} {journey} {station} {room} {hospital} {branch}
   */
  readonly instructions: string;
  readonly footer: string;
  /**
   * Governs whether the patient's name may be printed. A ticket can be dropped
   * in a corridor, so it obeys the same policy as the display board rather than
   * having a switch of its own.
   */
  readonly namePolicy: PatientNamePolicy;
  /** Base URL the QR code points at, e.g. "https://qman.hospital/track.html". */
  readonly trackingUrl: string;
}

export const DEFAULT_TICKET_TEMPLATE: TicketTemplate = {
  id: "ticket-default",
  name: "Reception ticket (80 mm)",
  paper: "thermal_80mm",
  elements: [
    { element: "hospitalName", condition: "always" },
    { element: "branch", condition: "if_multiple_branches" },
    { element: "queueTicket", condition: "always" },
    { element: "station", condition: "always" },
    { element: "room", condition: "if_present" },
    { element: "doctor", condition: "if_present" },
    { element: "journeyCode", condition: "always" },
    { element: "qrCode", condition: "always" },
    { element: "visitTime", condition: "always" },
    { element: "instructions", condition: "if_present" },
    { element: "footer", condition: "always" },
  ],
  instructions: "Scan the code to follow your place in the queue.",
  footer: "Please keep this ticket until your visit is complete.",
  namePolicy: "ticket_only",
  trackingUrl: "/track.html",
};

export interface TicketContext {
  readonly ticket: string;
  readonly journeyCode: JourneyCode;
  readonly patientName: string;
  readonly hospitalName: string;
  readonly branchName: string;
  readonly stationName: string;
  readonly room: string | null;
  /** The clinician assigned so far, if any. */
  readonly assignedTo: string | null;
  readonly issuedAt: Date;
  readonly logoUrl: string | null;
  /** Drives the `if_multiple_branches` condition. */
  readonly branchCount: number;
  /**
   * The visit's tracking token, when the ticket is printed for a real visit.
   *
   * Encoded in the QR code instead of the Journey Code. The code is four
   * characters from a small alphabet and is printed in plain sight; the token
   * is long and random, so a QR photographed over someone's shoulder is the
   * only way to obtain one.
   */
  readonly trackingToken?: string | null;
}

const TOKEN = /\{(\w+)\}/g;

export function renderTicketText(
  template: string,
  context: TicketContext,
): string {
  return template
    .replace(TOKEN, (match, name: string) => {
      switch (name) {
        case "ticket":
          return context.ticket;
        case "journey":
          return context.journeyCode;
        case "station":
          return context.stationName;
        case "room":
          return context.room ?? context.stationName;
        case "hospital":
          return context.hospitalName;
        case "branch":
          return context.branchName;
        default:
          return match;
      }
    })
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The URL encoded into the QR code.
 *
 * Deep-links straight to the patient's own journey, so scanning the ticket is
 * one step rather than "open the site, then type your code". The Journey Code
 * remains printed alongside it for anyone without a camera — the QR is a
 * convenience, never the only way in.
 */
export function trackingUrlFor(
  template: TicketTemplate,
  journeyCode: JourneyCode,
  trackingToken?: string | null,
): string {
  const base = template.trackingUrl.trim() || "/track.html";
  const separator = base.includes("?") ? "&" : "?";
  // The token when there is one. The Journey Code only for previews in the
  // administration portal, where there is no visit and so no token.
  if (trackingToken) return `${base}${separator}t=${encodeURIComponent(trackingToken)}`;
  return `${base}${separator}code=${encodeURIComponent(journeyCode)}`;
}

/** One resolved line of a ticket, ready to render. */
export interface TicketLine {
  readonly element: TicketElement;
  readonly label: string | null;
  readonly value: string;
}

/**
 * Resolves a template and context into the lines to print.
 *
 * Elements that resolve to nothing are dropped rather than printed empty — a
 * thermal ticket has no room for a blank labelled row, and a patient reading
 * "Patient name:" with nothing after it will assume something went wrong.
 */
export function renderTicket(
  template: TicketTemplate,
  context: TicketContext,
): TicketLine[] {
  const lines: TicketLine[] = [];

  for (const spec of template.elements) {
    const { element } = spec;

    // A condition that fails skips the element outright. Elements that survive
    // their condition are still dropped further down if they resolve to
    // nothing, so "always" never prints an empty labelled row.
    if (
      spec.condition === "if_multiple_branches" &&
      context.branchCount <= 1
    ) {
      continue;
    }
    if (spec.condition === "if_present" && !hasValue(element, context)) {
      continue;
    }

    switch (element) {
      case "logo":
        if (context.logoUrl) {
          lines.push({ element, label: null, value: context.logoUrl });
        }
        break;
      case "hospitalName":
        lines.push({ element, label: null, value: context.hospitalName });
        break;
      case "branch":
        if (context.branchName) {
          lines.push({ element, label: null, value: context.branchName });
        }
        break;
      case "queueTicket":
        lines.push({ element, label: "Your number", value: context.ticket });
        break;
      case "journeyCode":
        lines.push({
          element,
          label: "Journey code",
          value: context.journeyCode,
        });
        break;
      case "qrCode":
        lines.push({
          element,
          label: null,
          value: trackingUrlFor(template, context.journeyCode, context.trackingToken),
        });
        break;
      case "visitTime":
        lines.push({
          element,
          label: "Issued",
          value: context.issuedAt.toLocaleString([], {
            hour: "2-digit",
            minute: "2-digit",
            day: "2-digit",
            month: "short",
          }),
        });
        break;
      case "station":
        lines.push({
          element,
          label: "Please go to",
          value: context.stationName,
        });
        break;
      case "room":
        if (context.room) {
          lines.push({ element, label: "Room", value: context.room });
        }
        break;
      case "doctor":
        if (context.assignedTo) {
          lines.push({ element, label: "Seeing", value: context.assignedTo });
        }
        break;
      case "patientName": {
        const name = displayPatientName(context.patientName, template.namePolicy);
        if (name) lines.push({ element, label: "Patient", value: name });
        break;
      }
      case "instructions": {
        const text = renderTicketText(template.instructions, context);
        if (text) lines.push({ element, label: null, value: text });
        break;
      }
      case "footer": {
        const text = renderTicketText(template.footer, context);
        if (text) lines.push({ element, label: null, value: text });
        break;
      }
    }
  }

  return lines;
}

/** Whether an element has anything to print for this visit. */
function hasValue(element: TicketElement, context: TicketContext): boolean {
  switch (element) {
    case "logo":
      return context.logoUrl !== null;
    case "branch":
      return context.branchName.trim().length > 0;
    case "room":
      return context.room !== null && context.room.trim().length > 0;
    case "doctor":
      return (
        context.assignedTo !== null && context.assignedTo.trim().length > 0
      );
    case "patientName":
      return context.patientName.trim().length > 0;
    default:
      return true;
  }
}

/**
 * Validates a template at configuration time.
 *
 * The two errors that matter are both silent failures: a ticket with no
 * identifier is useless to the patient holding it, and a ticket with a QR code
 * but no printed Journey Code strands anyone whose camera will not scan.
 */
export function validateTicketTemplate(template: TicketTemplate): string[] {
  const problems: string[] = [];

  if (template.name.trim().length === 0) {
    problems.push("A ticket template needs a name.");
  }

  if (template.elements.length === 0) {
    problems.push("A ticket must print at least one element.");
    return problems;
  }

  /**
   * An identifier only counts if it prints unconditionally. A journey code set
   * to "only when known" would satisfy a naive check while still leaving some
   * tickets with nothing on them.
   */
  const printsAlways = (element: TicketElement) =>
    template.elements.some(
      (spec) => spec.element === element && spec.condition === "always",
    );
  const includes = (element: TicketElement) =>
    template.elements.some((spec) => spec.element === element);

  if (!printsAlways("queueTicket") && !printsAlways("journeyCode")) {
    problems.push(
      "A ticket must always print the queue number or the journey code, otherwise the patient has nothing to be called by.",
    );
  }

  if (includes("qrCode") && !printsAlways("journeyCode")) {
    problems.push(
      "Print the journey code alongside the QR code, so a patient whose camera fails can still track their visit.",
    );
  }

  const seen = new Set(template.elements.map((spec) => spec.element));
  if (seen.size !== template.elements.length) {
    problems.push("An element is listed more than once.");
  }

  const known = new Set(["ticket", "journey", "station", "room", "hospital", "branch"]);
  for (const [field, text] of [
    ["Instructions", template.instructions],
    ["Footer", template.footer],
  ] as const) {
    for (const match of text.matchAll(TOKEN)) {
      if (!known.has(match[1]!)) {
        problems.push(
          `${field}: "{${match[1]}}" is not a known token. Available: ${[...known]
            .map((t) => `{${t}}`)
            .join(", ")}.`,
        );
      }
    }
  }

  // A 58 mm roll is roughly 32 characters wide; long prose wraps into an
  // unreadable block and wastes paper on every single visit.
  const spec = PAPER_SPECS[template.paper];
  if (spec.widthMm < 60) {
    if (template.instructions.length > 120) {
      problems.push(
        "Instructions are too long for a narrow thermal roll. Keep them under 120 characters.",
      );
    }
    if (template.footer.length > 80) {
      problems.push(
        "The footer is too long for a narrow thermal roll. Keep it under 80 characters.",
      );
    }
  }

  return problems;
}
