import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: [
      "packages/**/src/**/*.test.{ts,tsx}",
      "apps/**/src/**/*.test.{ts,tsx}",
    ],
    // The domain suite is pure and stays on Node; only component tests pay for
    // a DOM.
    environment: "node",
    environmentMatchGlobs: [["apps/web/**", "jsdom"]],
  },
  resolve: {
    alias: {
      // Vitest runs TypeScript source directly, so @qman/domain resolves to the
      // package's src rather than a dist build that may not exist yet.
      "@qman/domain": new URL("./packages/domain/src/index.ts", import.meta.url)
        .pathname,
      "@qman/persistence": new URL(
        "./packages/persistence/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
