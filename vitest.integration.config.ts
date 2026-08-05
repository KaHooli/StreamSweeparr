import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Integration suite: exercises sync, sweep and the run lock against a real
 * PostgreSQL, so the SQL that the unit tests mock away is actually run.
 *
 * Requires DATABASE_URL to point at a throwaway database with the migrations
 * applied (`npx prisma migrate deploy`). CI provisions one as a service
 * container; locally, point it at a scratch database of your own.
 *
 * Kept separate from `npm test` so the fast unit suite stays runnable with no
 * infrastructure at all.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.itest.ts"],
    setupFiles: ["src/test/integrationSetup.ts"],
    // These tests share one database, so they must not run concurrently.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
