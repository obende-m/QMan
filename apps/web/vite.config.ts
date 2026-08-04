import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Three applications, one repository.
 *
 * The staff app, the display board and the patient tracker are separate builds
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
        staff: resolve(here, "index.html"),
        display: resolve(here, "display.html"),
        track: resolve(here, "track.html"),
      },
    },
  },
});
