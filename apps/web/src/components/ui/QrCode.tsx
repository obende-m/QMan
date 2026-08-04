import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * QR code rendering.
 *
 * Uses `qrcode-generator` rather than a hand-rolled encoder. QR encoding is
 * Reed-Solomon error correction, version selection and mask evaluation — a
 * correctness-critical algorithm where a subtle bug produces a code that scans
 * on the developer's phone and fails on a patient's. That is not a reasonable
 * thing to reimplement, and the library is ~10 kB with no dependencies.
 *
 * Rendered as inline SVG rather than a canvas or data URI so it stays crisp on
 * a thermal printer at any size, prints reliably (canvases frequently do not),
 * and needs no image request.
 */
export interface QrCodeProps {
  value: string;
  /** Rendered size. Use a CSS length; millimetres for print. */
  size?: string;
  /**
   * Error-correction level. "M" is the default: a printed ticket picks up
   * thermal fading and thumbprints, and M tolerates ~15% damage while staying
   * compact enough for a 58 mm roll.
   */
  level?: "L" | "M" | "Q" | "H";
  className?: string;
  title?: string;
}

export function QrCode({
  value,
  size = "28mm",
  level = "M",
  className,
  title = "Scan to track your visit",
}: QrCodeProps) {
  const { path, dimension } = useMemo(() => {
    // Type 0 lets the library pick the smallest version that fits the data.
    const qr = qrcode(0, level);
    qr.addData(value);
    qr.make();

    const count = qr.getModuleCount();
    const segments: string[] = [];

    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (!qr.isDark(row, column)) continue;
        // One path covering every dark module: far fewer DOM nodes than a rect
        // per module, which matters when a board re-renders often.
        segments.push(`M${column} ${row}h1v1h-1z`);
      }
    }

    return { path: segments.join(""), dimension: count };
  }, [value, level]);

  return (
    <svg
      role="img"
      aria-label={title}
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${dimension} ${dimension}`}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      {/* An explicit white background: a QR code printed onto a transparent
          area scans unreliably, and thermal paper is not always white. */}
      <rect width={dimension} height={dimension} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
