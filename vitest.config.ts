import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Unit suite — no database, no network.
 *
 * The default environment stays `node`: almost every test here is pure logic,
 * and standing up a DOM for those would only cost time. Component tests opt in
 * per file with a `@vitest-environment jsdom` docblock. That is deliberately a
 * file-level annotation rather than a config glob — the glob option
 * (`environmentMatchGlobs`) is on its way out of Vitest, the docblock is not.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
