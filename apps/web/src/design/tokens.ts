/**
 * Design tokens, transcribed from design/qman_clinical_flow/DESIGN.md.
 *
 * This file is the single source of truth for the visual language. The Tailwind
 * config derives every colour, type scale and spacing step from here, and emits
 * the CSS custom properties that drive light and dark themes — so a token is
 * changed in exactly one place.
 */

/** Material-3 style role names, as used throughout the Stitch screens. */
export const lightColors = {
  surface: "#f7f9fb",
  "surface-dim": "#d8dadc",
  "surface-bright": "#f7f9fb",
  "surface-container-lowest": "#ffffff",
  "surface-container-low": "#f2f4f6",
  "surface-container": "#eceef0",
  "surface-container-high": "#e6e8ea",
  "surface-container-highest": "#e0e3e5",
  "surface-variant": "#e0e3e5",
  "on-surface": "#191c1e",
  "on-surface-variant": "#434656",
  "inverse-surface": "#2d3133",
  "inverse-on-surface": "#eff1f3",
  outline: "#737688",
  "outline-variant": "#c3c5d9",
  "surface-tint": "#004ced",
  primary: "#003ec7",
  "on-primary": "#ffffff",
  "primary-container": "#0052ff",
  "on-primary-container": "#dfe3ff",
  "inverse-primary": "#b7c4ff",
  secondary: "#505f76",
  "on-secondary": "#ffffff",
  "secondary-container": "#d0e1fb",
  "on-secondary-container": "#54647a",
  tertiary: "#005a3c",
  "on-tertiary": "#ffffff",
  "tertiary-container": "#007550",
  "on-tertiary-container": "#72fec0",
  error: "#ba1a1a",
  "on-error": "#ffffff",
  "error-container": "#ffdad6",
  "on-error-container": "#93000a",
  "primary-fixed": "#dde1ff",
  "primary-fixed-dim": "#b7c4ff",
  "on-primary-fixed": "#001452",
  "on-primary-fixed-variant": "#0038b6",
  "secondary-fixed": "#d3e4fe",
  "secondary-fixed-dim": "#b7c8e1",
  "on-secondary-fixed": "#0b1c30",
  "on-secondary-fixed-variant": "#38485d",
  "tertiary-fixed": "#6ffbbe",
  "tertiary-fixed-dim": "#4edea3",
  "on-tertiary-fixed": "#002113",
  "on-tertiary-fixed-variant": "#005236",
  background: "#f7f9fb",
  "on-background": "#191c1e",

  /**
   * Functional accents. DESIGN.md specifies a warm amber for "Waiting" —
   * "caution without triggering panic" — but the token block omits it, so the
   * ramp is defined here to keep every colour in one place.
   */
  warning: "#8a5100",
  "on-warning": "#ffffff",
  "warning-container": "#ffdcbe",
  "on-warning-container": "#2b1700",
} as const;

/**
 * Dark theme.
 *
 * DESIGN.md calls for "a deep charcoal-navy base to reduce eye strain during
 * night shifts, maintaining high legibility through adjusted contrast ratios".
 * Night shifts are exactly when a patient-flow system is most safety-critical,
 * so this is a first-class theme rather than an inversion filter: surfaces are
 * navy-tinted neutrals, and every foreground pair was chosen to clear WCAG AA
 * (4.5:1 for text) against the surface it sits on.
 */
export const darkColors: Record<keyof typeof lightColors, string> = {
  surface: "#111418",
  "surface-dim": "#0b0e12",
  "surface-bright": "#2f3339",
  "surface-container-lowest": "#0c0f13",
  "surface-container-low": "#191c21",
  "surface-container": "#1d2025",
  "surface-container-high": "#272a30",
  "surface-container-highest": "#32353b",
  "surface-variant": "#43474e",
  "on-surface": "#e2e2e6",
  "on-surface-variant": "#c3c6cf",
  "inverse-surface": "#e2e2e6",
  "inverse-on-surface": "#2f3033",
  outline: "#8d9199",
  "outline-variant": "#43474e",
  "surface-tint": "#b7c4ff",
  primary: "#b7c4ff",
  "on-primary": "#002585",
  "primary-container": "#0038b6",
  "on-primary-container": "#dde1ff",
  "inverse-primary": "#003ec7",
  secondary: "#b7c8e1",
  "on-secondary": "#22324a",
  "secondary-container": "#38485d",
  "on-secondary-container": "#d3e4fe",
  tertiary: "#4edea3",
  "on-tertiary": "#003825",
  "tertiary-container": "#005236",
  "on-tertiary-container": "#6ffbbe",
  error: "#ffb4ab",
  "on-error": "#690005",
  "error-container": "#93000a",
  "on-error-container": "#ffdad6",
  "primary-fixed": "#dde1ff",
  "primary-fixed-dim": "#b7c4ff",
  "on-primary-fixed": "#001452",
  "on-primary-fixed-variant": "#0038b6",
  "secondary-fixed": "#d3e4fe",
  "secondary-fixed-dim": "#b7c8e1",
  "on-secondary-fixed": "#0b1c30",
  "on-secondary-fixed-variant": "#38485d",
  "tertiary-fixed": "#6ffbbe",
  "tertiary-fixed-dim": "#4edea3",
  "on-tertiary-fixed": "#002113",
  "on-tertiary-fixed-variant": "#005236",
  background: "#0d1014",
  "on-background": "#e2e2e6",

  warning: "#ffb868",
  "on-warning": "#4a2800",
  "warning-container": "#693c00",
  "on-warning-container": "#ffdcbe",
};

/**
 * Type scale. `label-caps` is the monospace layer for codes and timestamps.
 *
 * Not `as const`: Tailwind's `fontSize` expects mutable tuples.
 */
export const typography: Record<
  string,
  [string, { lineHeight: string; letterSpacing?: string; fontWeight: string }]
> = {
  "display-lg": ["48px", { lineHeight: "56px", letterSpacing: "-0.02em", fontWeight: "700" }],
  "headline-lg": ["32px", { lineHeight: "40px", letterSpacing: "-0.01em", fontWeight: "600" }],
  "headline-lg-mobile": ["24px", { lineHeight: "32px", fontWeight: "600" }],
  "title-md": ["18px", { lineHeight: "24px", fontWeight: "600" }],
  "body-md": ["15px", { lineHeight: "24px", fontWeight: "400" }],
  "body-sm": ["13px", { lineHeight: "20px", fontWeight: "400" }],
  "label-caps": ["11px", { lineHeight: "16px", letterSpacing: "0.05em", fontWeight: "600" }],
};

export const radii = {
  sm: "0.25rem",
  DEFAULT: "0.5rem",
  md: "0.75rem",
  lg: "1rem",
  xl: "1.5rem",
  full: "9999px",
} as const;

export const spacing = {
  gutter: "24px",
  margin: "32px",
  "sidebar-width": "260px",
} as const;

/**
 * Elevation, per DESIGN.md: tonal layering with ambient shadows rather than
 * heavy drop shadows.
 */
export const elevation = {
  card: "0px 4px 12px rgba(0,0,0,0.03)",
  modal: "0px 12px 32px rgba(0,0,0,0.08)",
} as const;

/** Converts "#rrggbb" to the "r g b" triplet Tailwind needs for alpha support. */
export function toRgbChannels(hex: string): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}
