// ABOUTME: Configures Picot's browser and build-script Vitest regression suites.
// ABOUTME: Keeps distribution-asset checks alongside frontend behavior tests.
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "bun-text-imports",
      enforce: "pre",
      load(id) {
        const filePath = id.split("?", 1)[0];
        if (!filePath.endsWith(".md")) return null;
        return `export default ${JSON.stringify(readFileSync(filePath, "utf8"))};`;
      },
    },
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.js"],
    include: ["public/**/*.test.js", "extensions/**/*.test.ts", "scripts/**/*.test.js"],
    coverage: {
      provider: "istanbul",
      enabled: false,
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["public/**/*.js", "extensions/**/*.ts", "scripts/**/*.js"],
      exclude: [
        "**/*.test.{js,ts}",
        "extensions/dist/**",
        // These extension entry points run inside the Pi host; jsdom mocks do
        // not provide a meaningful measure of their production behavior.
        "extensions/pi-chat-src/**",
        // Node CLI scripts have contract tests but do not execute under jsdom.
        "scripts/**",
        "public/**/*-vendor-entry.js",
        "public/vendor/**",
      ],
    },
  },
});
