import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Five pages, one repository.
 *
 * The public product page (index.html), the staff app (app.html), the display
 * board, the patient tracker and the platform portal are separate builds
 * rather than routes, so the public surfaces ship none of the staff code that
 * can mutate clinical state. They share the domain engine, the design system
 * and the component library — but not the bundle.
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      input: {
        site: resolve(here, "index.html"),
        staff: resolve(here, "app.html"),
        display: resolve(here, "display.html"),
        track: resolve(here, "track.html"),
        platform: resolve(here, "platform.html"),
      },
    },
  },
});
