import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tailwind resolves its config relative to the working directory rather than to
 * this file, so the path is given explicitly.
 *
 * Run the app through `npm run dev` / `npm run build -w @qman/web`, which set
 * the working directory to this package. Invoking Vite directly from the repo
 * root (`npx vite apps/web`) is still not supported — PostCSS config discovery
 * does not follow Vite's `root`, and the symptom is an unstyled app rather than
 * a clear error.
 */
const here = dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: join(here, "tailwind.config.ts") },
    autoprefixer: {},
  },
};
