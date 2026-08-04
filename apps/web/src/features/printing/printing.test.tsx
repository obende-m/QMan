import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  DEFAULT_TICKET_TEMPLATE,
  parseJourneyCode,
  type TicketContext,
} from "@qman/domain";
import { PrintableTicket } from "./PrintableTicket.js";
import { TicketPrintDialog } from "./TicketPrintDialog.js";
import { QrCode } from "../../components/ui/QrCode.js";

const context: TicketContext = {
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
};

describe("QR code", () => {
  afterEach(cleanup);

  it("renders as inline SVG so it prints crisply at any size", () => {
    render(<QrCode value="https://qman.example/track.html?code=QM-8F4K" />);
    const svg = screen.getByRole("img", { name: /scan to track/i });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.querySelector("path")?.getAttribute("d")).toBeTruthy();
  });

  it("carries an opaque white background so it scans off thermal paper", () => {
    render(<QrCode value="QM-8F4K" />);
    const rect = screen.getByRole("img").querySelector("rect");
    expect(rect?.getAttribute("fill")).toBe("#ffffff");
  });

  it("grows its module count as the encoded data grows", () => {
    render(<QrCode value="QM-8F4K" title="short" />);
    const short = screen
      .getByRole("img", { name: "short" })
      .getAttribute("viewBox");
    cleanup();

    render(<QrCode value={"https://example.com/track.html?code=".repeat(4)} title="long" />);
    const long = screen.getByRole("img", { name: "long" }).getAttribute("viewBox");

    const modules = (box: string | null) => Number(box!.split(" ")[2]);
    expect(modules(long)).toBeGreaterThan(modules(short));
  });
});

describe("printable ticket", () => {
  afterEach(cleanup);

  it("prints the queue number as the largest thing on the paper", () => {
    render(
      <PrintableTicket template={DEFAULT_TICKET_TEMPLATE} context={context} />,
    );
    const ticket = screen.getByTestId("printable-ticket");
    const number = within(ticket).getByText("A-023");
    // 2.6em against a 10pt base — readable across a waiting room.
    expect(number.style.fontSize).toBe("2.6em");
  });

  it("prints the journey code alongside the QR code", () => {
    render(
      <PrintableTicket template={DEFAULT_TICKET_TEMPLATE} context={context} />,
    );
    const ticket = screen.getByTestId("printable-ticket");
    expect(within(ticket).getByText("QM-8F4K")).toBeDefined();
    expect(within(ticket).getByRole("img", { name: /scan to track/i })).toBeDefined();
  });

  it("sizes itself to the configured paper", () => {
    render(
      <PrintableTicket
        template={{ ...DEFAULT_TICKET_TEMPLATE, paper: "thermal_58mm" }}
        context={context}
      />,
    );
    expect(screen.getByTestId("printable-ticket").style.width).toBe("48mm");

    cleanup();
    render(
      <PrintableTicket
        template={{ ...DEFAULT_TICKET_TEMPLATE, paper: "a4" }}
        context={context}
      />,
    );
    expect(screen.getByTestId("printable-ticket").style.width).toBe("210mm");
  });

  /**
   * Thermal paper has one colour. A ticket inheriting the app's surface palette
   * prints as a grey block.
   */
  it("is black on white regardless of the app theme", () => {
    render(
      <PrintableTicket template={DEFAULT_TICKET_TEMPLATE} context={context} />,
    );
    const ticket = screen.getByTestId("printable-ticket");
    expect(ticket.style.background).toBe("rgb(255, 255, 255)");
    expect(ticket.style.color).toBe("rgb(0, 0, 0)");
  });

  it("omits the patient name unless the policy allows it", () => {
    render(
      <PrintableTicket
        template={{
          ...DEFAULT_TICKET_TEMPLATE,
          elements: [
            ...DEFAULT_TICKET_TEMPLATE.elements,
            { element: "patientName" as const, condition: "always" as const },
          ],
        }}
        context={context}
      />,
    );
    expect(screen.queryByText("Amara Okafor")).toBeNull();
  });
});

describe("ticket print dialog", () => {
  let closed: number;

  beforeEach(() => {
    closed = 0;
  });

  afterEach(cleanup);

  it("shows the ticket for review before printing", () => {
    render(
      <TicketPrintDialog
        template={DEFAULT_TICKET_TEMPLATE}
        context={context}
        onClose={() => (closed += 1)}
      />,
    );
    // A receptionist must see whose ticket is about to come out.
    expect(screen.getByRole("dialog", { name: /print ticket/i })).toBeDefined();
    expect(screen.getByTestId("printable-ticket")).toBeDefined();
    expect(screen.getByRole("button", { name: /^print$/i })).toBeDefined();
  });

  it("names the paper so the wrong roll is obvious before printing", () => {
    render(
      <TicketPrintDialog
        template={{ ...DEFAULT_TICKET_TEMPLATE, paper: "thermal_58mm" }}
        context={context}
        onClose={() => (closed += 1)}
      />,
    );
    expect(screen.getByText(/58 mm thermal roll/i)).toBeDefined();
  });

  it("closes on Escape and on Cancel", () => {
    render(
      <TicketPrintDialog
        template={DEFAULT_TICKET_TEMPLATE}
        context={context}
        onClose={() => (closed += 1)}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(closed).toBe(2);
  });

  /**
   * Printing goes through an iframe rather than the page, so the ticket carries
   * its own @page size instead of inheriting the application's layout.
   */
  it("prints through an isolated document", () => {
    // jsdom has no print implementation and logs loudly when one is called;
    // the assertion here is about the document handed to it, not the call.
    const notImplemented = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <TicketPrintDialog
        template={DEFAULT_TICKET_TEMPLATE}
        context={context}
        onClose={() => (closed += 1)}
      />,
    );

    const before = document.querySelectorAll("iframe").length;
    fireEvent.click(screen.getByRole("button", { name: /^print$/i }));
    expect(document.querySelectorAll("iframe").length).toBe(before + 1);

    const frame = document.querySelector("iframe")!;
    const printed = frame.contentDocument!.documentElement.innerHTML;
    expect(printed).toMatch(/@page/);
    expect(printed).toMatch(/72mm/);
    expect(printed).toMatch(/A-023/);

    notImplemented.mockRestore();
  });
});
