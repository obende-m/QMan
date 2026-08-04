import { useEffect, useRef } from "react";
import { Printer, X } from "lucide-react";
import { PAPER_SPECS, type TicketContext, type TicketTemplate } from "@qman/domain";
import { Button } from "../../components/ui/Button.js";
import { PrintableTicket } from "./PrintableTicket.js";

/**
 * The ticket print dialogue.
 *
 * Shows the ticket on screen first rather than firing the printer immediately.
 * A receptionist needs to see that the right patient's ticket is about to come
 * out — and a mis-printed thermal ticket is paper in the bin and a patient
 * holding the wrong number.
 *
 * Printing uses a hidden iframe rather than `window.print()` on the page. The
 * page print would inherit the application's layout, fonts and dark theme; an
 * iframe carries only the ticket and its own `@page` size, which is what makes
 * a 58 mm roll come out at 58 mm.
 */
export interface TicketPrintDialogProps {
  template: TicketTemplate;
  context: TicketContext;
  onClose: () => void;
}

export function TicketPrintDialog({
  template,
  context,
  onClose,
}: TicketPrintDialogProps) {
  const ticketRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const print = () => {
    const markup = ticketRef.current?.innerHTML;
    if (!markup) return;

    const spec = PAPER_SPECS[template.paper];
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.position = "fixed";
    frame.style.right = "0";
    frame.style.bottom = "0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    document.body.appendChild(frame);

    const doc = frame.contentDocument;
    if (!doc) {
      frame.remove();
      return;
    }

    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Ticket ${context.ticket}</title>
<style>
  @page {
    size: ${spec.widthMm}mm ${spec.heightMm ? `${spec.heightMm}mm` : "auto"};
    margin: 0;
  }
  html, body { margin: 0; padding: 0; background: #fff; }
  /* Thermal printers render greys as dither patterns, which smears a QR code.
     Forcing exact colour keeps it solid black on white. */
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
</style>
</head><body>${markup}</body></html>`);
    doc.close();

    const run = () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      // Give the print dialogue time to take the document before removing it.
      window.setTimeout(() => frame.remove(), 1000);
    };

    if (frame.contentWindow?.document.readyState === "complete") {
      run();
    } else {
      frame.addEventListener("load", run, { once: true });
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-inverse-surface/50 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Print ticket"
        tabIndex={-1}
        className="max-h-full w-full max-w-md overflow-y-auto rounded-lg border border-outline-variant bg-surface-container-lowest shadow-modal focus:outline-none"
      >
        <header className="flex items-center justify-between gap-4 border-b border-outline-variant px-gutter py-4">
          <div>
            <h2 className="text-title-md font-semibold text-on-surface">
              Print ticket
            </h2>
            <p className="text-body-sm text-on-surface-variant">
              {template.name} · {PAPER_SPECS[template.paper].label}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1.5 text-on-surface-variant hover:bg-surface-container"
          >
            <X className="size-5" />
          </button>
        </header>

        <div className="flex justify-center bg-surface-container p-gutter">
          {/* A visible border stands in for the paper edge so a receptionist can
              see the ticket will fit the roll. */}
          <div ref={ticketRef} className="shadow-card ring-1 ring-outline-variant">
            <PrintableTicket template={template} context={context} />
          </div>
        </div>

        <footer className="flex justify-end gap-2 border-t border-outline-variant px-gutter py-4">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon={<Printer className="size-4" />} onClick={print}>
            Print
          </Button>
        </footer>
      </div>
    </div>
  );
}
