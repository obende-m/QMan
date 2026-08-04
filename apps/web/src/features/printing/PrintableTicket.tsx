import {
  PAPER_SPECS,
  renderTicket,
  type TicketContext,
  type TicketTemplate,
} from "@qman/domain";
import { QrCode } from "../../components/ui/QrCode.js";

/**
 * The printed ticket.
 *
 * Rendered as real DOM and printed by the browser rather than generated as a
 * PDF. A reception desk's printer is already configured in the operating
 * system, the browser print dialogue is the workflow staff already know, and it
 * works on the thermal printers hospitals actually own without QMan shipping a
 * driver.
 *
 * Everything is deliberately black on white with no theme tokens: thermal paper
 * has one colour, and a ticket that inherits the app's surface palette prints
 * as a grey block.
 */
export interface PrintableTicketProps {
  template: TicketTemplate;
  context: TicketContext;
}

export function PrintableTicket({ template, context }: PrintableTicketProps) {
  const spec = PAPER_SPECS[template.paper];
  const lines = renderTicket(template, context);

  return (
    <div
      data-testid="printable-ticket"
      className="qman-ticket"
      style={{
        width: `${spec.widthMm}mm`,
        padding: `${spec.marginMm}mm`,
        fontSize: `${spec.baseFontPt}pt`,
        background: "#ffffff",
        color: "#000000",
        fontFamily: "Inter, system-ui, sans-serif",
        lineHeight: 1.35,
      }}
    >
      {lines.map((line, index) => {
        switch (line.element) {
          case "logo":
            return (
              <img
                key={index}
                src={line.value}
                alt=""
                style={{ maxWidth: "100%", maxHeight: "16mm", margin: "0 auto 2mm", display: "block" }}
              />
            );

          case "hospitalName":
            return (
              <p
                key={index}
                style={{
                  textAlign: "center",
                  fontWeight: 700,
                  fontSize: "1.15em",
                  margin: 0,
                }}
              >
                {line.value}
              </p>
            );

          case "branch":
            return (
              <p
                key={index}
                style={{ textAlign: "center", margin: "0 0 2mm", fontSize: "0.85em" }}
              >
                {line.value}
              </p>
            );

          // The queue number is what gets called across a waiting room, so it
          // is by far the largest thing on the paper — readable at arm's length
          // by someone who has left their glasses at home.
          case "queueTicket":
            return (
              <div
                key={index}
                style={{
                  textAlign: "center",
                  borderTop: "1px dashed #000",
                  borderBottom: "1px dashed #000",
                  padding: "2mm 0",
                  margin: "2mm 0",
                }}
              >
                <p style={{ margin: 0, fontSize: "0.75em", letterSpacing: "0.08em" }}>
                  {line.label?.toUpperCase()}
                </p>
                <p
                  style={{
                    margin: 0,
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    fontWeight: 700,
                    fontSize: "2.6em",
                    lineHeight: 1.1,
                  }}
                >
                  {line.value}
                </p>
              </div>
            );

          case "qrCode":
            return (
              <div key={index} style={{ textAlign: "center", margin: "2mm 0" }}>
                <QrCode
                  value={line.value}
                  size={`${Math.min(32, spec.widthMm - spec.marginMm * 2 - 6)}mm`}
                />
              </div>
            );

          case "journeyCode":
            return (
              <div key={index} style={{ textAlign: "center", margin: "1mm 0" }}>
                <p style={{ margin: 0, fontSize: "0.75em", letterSpacing: "0.08em" }}>
                  {line.label?.toUpperCase()}
                </p>
                <p
                  style={{
                    margin: 0,
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    fontWeight: 700,
                    fontSize: "1.3em",
                  }}
                >
                  {line.value}
                </p>
              </div>
            );

          case "instructions":
          case "footer":
            return (
              <p
                key={index}
                style={{
                  textAlign: "center",
                  margin: "2mm 0 0",
                  fontSize: "0.8em",
                }}
              >
                {line.value}
              </p>
            );

          default:
            return (
              <p
                key={index}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "3mm",
                  margin: "0.6mm 0",
                }}
              >
                {line.label && (
                  <span style={{ fontSize: "0.85em" }}>{line.label}</span>
                )}
                <span style={{ fontWeight: 600, textAlign: "right" }}>
                  {line.value}
                </span>
              </p>
            );
        }
      })}
    </div>
  );
}
