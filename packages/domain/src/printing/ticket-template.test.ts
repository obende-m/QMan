import { describe, expect, it } from "vitest";
import {
  DEFAULT_TICKET_TEMPLATE,
  PAPER_SPECS,
  renderTicket,
  renderTicketText,
  trackingUrlFor,
  validateTicketTemplate,
  type TicketContext,
  type TicketElement,
  type TicketTemplate,
} from "./ticket-template.js";
import { parseJourneyCode } from "../journey/journey-code.js";

/** Element specs default to "always" unless a test is exercising conditions. */
const els = (...elements: TicketElement[]) =>
  elements.map((element) => ({ element, condition: "always" as const }));

const context = (overrides: Partial<TicketContext> = {}): TicketContext => ({
  ticket: "A-023",
  journeyCode: parseJourneyCode("QM-8F4K"),
  patientName: "Amara Okafor",
  hospitalName: "Ikeja General Hospital",
  branchName: "Main Branch",
  stationName: "Consultation",
  room: "Room 12",
  assignedTo: null,
  branchCount: 1,
  issuedAt: new Date("2026-03-09T09:15:00Z"),
  logoUrl: null,
  ...overrides,
});

const template = (overrides: Partial<TicketTemplate> = {}): TicketTemplate => ({
  ...DEFAULT_TICKET_TEMPLATE,
  ...overrides,
});

describe("ticket rendering", () => {
  it("prints the elements the template asks for, in that order", () => {
    const lines = renderTicket(
      template({ elements: els("queueTicket", "journeyCode", "hospitalName") }),
      context(),
    );
    expect(lines.map((l) => l.element)).toEqual([
      "queueTicket",
      "journeyCode",
      "hospitalName",
    ]);
    expect(lines[0]!.value).toBe("A-023");
    expect(lines[1]!.value).toBe("QM-8F4K");
  });

  it("prints the station and the room as separate lines", () => {
    // Separate, because the room is conditional and the station is not.
    const lines = renderTicket(
      template({ elements: els("station", "room") }),
      context(),
    );
    expect(lines.map((l) => l.value)).toEqual(["Consultation", "Room 12"]);
  });
});

describe("conditional elements", () => {
  /**
   * Conditions keep a ticket compact without needing a separate template for
   * every small variation.
   */
  it("omits a room that is not known", () => {
    const lines = renderTicket(
      template({
        elements: [
          { element: "station", condition: "always" },
          { element: "room", condition: "if_present" },
        ],
      }),
      context({ room: null }),
    );
    expect(lines.map((l) => l.element)).toEqual(["station"]);
  });

  it("omits the clinician until one is assigned, then prints them", () => {
    const spec = template({
      elements: [{ element: "doctor", condition: "if_present" }],
    });

    expect(renderTicket(spec, context({ assignedTo: null }))).toEqual([]);

    const [line] = renderTicket(spec, context({ assignedTo: "Dr Adams" }));
    expect(line!.value).toBe("Dr Adams");
    expect(line!.label).toBe("Seeing");
  });

  it("omits the branch for a single-site hospital", () => {
    const spec = template({
      elements: [{ element: "branch", condition: "if_multiple_branches" }],
    });

    expect(renderTicket(spec, context({ branchCount: 1 }))).toEqual([]);
    expect(renderTicket(spec, context({ branchCount: 3 }))).toHaveLength(1);
  });

  it("prints an always-element even when a conditional peer is skipped", () => {
    const lines = renderTicket(
      template({
        elements: [
          { element: "branch", condition: "if_multiple_branches" },
          { element: "queueTicket", condition: "always" },
        ],
      }),
      context({ branchCount: 1 }),
    );
    expect(lines.map((l) => l.element)).toEqual(["queueTicket"]);
  });

  it("still drops an always-element that has nothing to print", () => {
    // "Always" governs the condition, not the existence of a value.
    expect(
      renderTicket(
        template({ elements: els("doctor") }),
        context({ assignedTo: null }),
      ),
    ).toEqual([]);
  });

  /**
   * A ticket can be dropped in a corridor, so it obeys the hospital's name
   * policy rather than carrying a switch of its own.
   */
  it("omits the patient name under a ticket-only policy", () => {
    expect(
      renderTicket(
        template({ elements: els("patientName"), namePolicy: "ticket_only" }),
        context(),
      ),
    ).toEqual([]);
  });

  it("prints the name when the hospital opts in", () => {
    const [line] = renderTicket(
      template({ elements: els("patientName"), namePolicy: "first_name" }),
      context(),
    );
    expect(line!.value).toBe("Amara");
  });

  it("drops elements that resolve to nothing rather than printing them empty", () => {
    // A labelled row with nothing after it reads as a fault on a thermal slip.
    const lines = renderTicket(
      template({ elements: els("logo", "branch", "instructions"), instructions: "" }),
      context({ logoUrl: null, branchName: "" }),
    );
    expect(lines).toEqual([]);
  });

  it("substitutes tokens in the instructions and footer", () => {
    const [line] = renderTicket(
      template({
        elements: els("instructions"),
        instructions: "Welcome to {hospital}, {branch}. Go to {station}.",
      }),
      context(),
    );
    expect(line!.value).toBe(
      "Welcome to Ikeja General Hospital, Main Branch. Go to Consultation.",
    );
  });

  it("leaves an unknown token visible rather than guessing", () => {
    expect(renderTicketText("Ward {ward}", context())).toBe("Ward {ward}");
  });
});

describe("QR tracking URL", () => {
  it("deep-links to the patient's own journey", () => {
    expect(
      trackingUrlFor(template(), parseJourneyCode("QM-8F4K")),
    ).toBe("/track.html?code=QM-8F4K");
  });

  it("appends correctly to a URL that already has a query", () => {
    expect(
      trackingUrlFor(
        template({ trackingUrl: "https://qman.example/track.html?kiosk=1" }),
        parseJourneyCode("QM-8F4K"),
      ),
    ).toBe("https://qman.example/track.html?kiosk=1&code=QM-8F4K");
  });

  it("falls back to a sane default when the URL is blank", () => {
    expect(
      trackingUrlFor(template({ trackingUrl: "  " }), parseJourneyCode("QM-8F4K")),
    ).toBe("/track.html?code=QM-8F4K");
  });
});

describe("ticket template validation", () => {
  it("accepts the shipped default", () => {
    expect(validateTicketTemplate(DEFAULT_TICKET_TEMPLATE)).toEqual([]);
  });

  /**
   * A ticket with nothing to be called by is useless to the patient holding it.
   */
  it("refuses a ticket with no identifier on it", () => {
    const problems = validateTicketTemplate(
      template({ elements: els("hospitalName", "footer") }),
    );
    expect(problems.join(" ")).toMatch(/nothing to be called by/);
  });

  /**
   * A conditional identifier is not an identifier: it would satisfy a naive
   * check while still leaving some tickets with nothing on them.
   */
  it("refuses an identifier that only prints sometimes", () => {
    const problems = validateTicketTemplate(
      template({
        elements: [
          { element: "queueTicket", condition: "if_present" },
          { element: "journeyCode", condition: "if_present" },
        ],
      }),
    );
    expect(problems.join(" ")).toMatch(/must always print/);
  });

  /**
   * A QR code without a printed journey code strands anyone whose camera will
   * not scan — an older phone, a cracked lens, a patient who cannot use one.
   */
  it("requires the journey code to be printed alongside a QR code", () => {
    const problems = validateTicketTemplate(
      template({ elements: els("queueTicket", "qrCode") }),
    );
    expect(problems.join(" ")).toMatch(/alongside the QR code/);
  });

  it("accepts a QR code when the journey code is also printed", () => {
    expect(
      validateTicketTemplate(
        template({ elements: els("queueTicket", "journeyCode", "qrCode") }),
      ),
    ).toEqual([]);
  });

  it("rejects an empty template and a duplicated element", () => {
    expect(validateTicketTemplate(template({ elements: [] })).join(" ")).toMatch(
      /at least one element/,
    );
    expect(
      validateTicketTemplate(
        template({ elements: els("queueTicket", "queueTicket") }),
      ).join(" "),
    ).toMatch(/more than once/);
  });

  it("names an unknown token in the wording", () => {
    const problems = validateTicketTemplate(
      template({ footer: "Call {ward} if lost." }),
    );
    expect(problems.join(" ")).toMatch(/"\{ward\}" is not a known token/);
  });

  /**
   * A 58 mm roll is about 32 characters wide; long prose wraps into an
   * unreadable block and wastes paper on every single visit.
   */
  it("rejects prose too long for a narrow roll", () => {
    const problems = validateTicketTemplate(
      template({
        paper: "thermal_58mm",
        instructions: "x".repeat(200),
      }),
    );
    expect(problems.join(" ")).toMatch(/too long for a narrow thermal roll/);
  });

  it("allows the same prose on A4", () => {
    expect(
      validateTicketTemplate(
        template({ paper: "a4", instructions: "x".repeat(200) }),
      ),
    ).toEqual([]);
  });
});

describe("paper specifications", () => {
  it("uses printable width, not quoted paper width, for thermal rolls", () => {
    // An 80 mm roll has roughly 72 mm of printable area; printing to 80 would
    // clip every ticket at the edges.
    expect(PAPER_SPECS.thermal_80mm.widthMm).toBeLessThan(80);
    expect(PAPER_SPECS.thermal_58mm.widthMm).toBeLessThan(58);
  });

  it("treats rolls as continuous and sheets as fixed height", () => {
    expect(PAPER_SPECS.thermal_58mm.heightMm).toBeNull();
    expect(PAPER_SPECS.thermal_80mm.heightMm).toBeNull();
    expect(PAPER_SPECS.a4.heightMm).toBe(297);
  });

  it("scales type to the paper width", () => {
    expect(PAPER_SPECS.a4.baseFontPt).toBeGreaterThan(
      PAPER_SPECS.thermal_58mm.baseFontPt,
    );
  });
});
