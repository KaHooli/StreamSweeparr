/**
 * Guard rail for the integration suite.
 *
 * These tests truncate tables, so refusing to start without an explicit
 * DATABASE_URL is deliberate: nobody should be able to point the suite at a
 * real deployment by forgetting to set an env var.
 */
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. The integration suite needs a throwaway PostgreSQL " +
      "with migrations applied: `npx prisma migrate deploy`. Run `npm test` for the " +
      "unit suite, which needs no database."
  );
}

// A signing secret is needed by anything that touches sessions.
process.env.AUTH_SECRET ||= "integration-test-secret-that-is-long-enough";
