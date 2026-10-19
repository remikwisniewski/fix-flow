import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    coverage: {
      provider: "v8",
      // The engine is pure and runs anywhere, so it carries the coverage bar.
      // UI modules are verified in the browser.
      include: ["src/engine/**/*.js", "src/ui/format.js", "src/ui/orders.js"],
      reporter: ["text", "html", "lcov"],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
});
