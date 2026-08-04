import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import {
  darkColors,
  elevation,
  lightColors,
  radii,
  spacing,
  toRgbChannels,
  typography,
} from "./src/design/tokens.js";

/**
 * Colours resolve through CSS custom properties rather than literal hex, so a
 * single `.dark` class on <html> re-themes the entire application with no
 * `dark:` variant on any component. Emitting them as "r g b" channels keeps
 * Tailwind's alpha modifiers working — `bg-primary/10` is what the "In Progress"
 * chip needs.
 */
const colorVars = Object.fromEntries(
  Object.keys(lightColors).map((token) => [
    token,
    `rgb(var(--color-${token}) / <alpha-value>)`,
  ]),
);

const themeVariables = plugin(({ addBase }) => {
  const toVars = (palette: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(palette).map(([token, hex]) => [
        `--color-${token}`,
        toRgbChannels(hex),
      ]),
    );

  addBase({
    ":root": toVars(lightColors),
    ".dark": toVars(darkColors),
  });
});

/**
 * Content globs are anchored to this file rather than to the working directory.
 * Relative globs silently match nothing when Vite is launched from the repo
 * root, and the failure mode is an unstyled app rather than an error — so the
 * paths are made absolute instead.
 */
const here = dirname(fileURLToPath(import.meta.url));

export default {
  content: [join(here, "index.html"), join(here, "src/**/*.{ts,tsx}")],
  darkMode: "class",
  theme: {
    extend: {
      colors: colorVars,
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      fontSize: typography,
      borderRadius: radii,
      spacing,
      maxWidth: { "container-max": "1440px" },
      width: { "sidebar-width": spacing["sidebar-width"] },
      boxShadow: elevation,
      keyframes: {
        /** DESIGN.md: urgent chips carry a pulsing animation. */
        "pulse-urgent": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
      },
      animation: {
        "pulse-urgent": "pulse-urgent 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [themeVariables],
} satisfies Config;
