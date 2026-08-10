import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/*
 * `.mts` rather than `.ts`: Vite loads a `.ts` config as CommonJS unless the
 * nearest package.json says otherwise, and warns on every run that the ESM
 * syntax here will stop working when its native config loader becomes the
 * default. The extension states the module system outright, which is cheaper
 * than adding `"type": "module"` to package.json and auditing what that moves.
 */

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
