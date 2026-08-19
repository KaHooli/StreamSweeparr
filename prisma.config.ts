/**
 * Prisma CLI configuration.
 *
 * Prisma 7 moved the datasource URL out of schema.prisma and stopped loading
 * `.env` on its own, so this file is what `prisma migrate deploy`,
 * `prisma generate` and `prisma db push` read to find the database. The app
 * itself never loads it — at runtime the connection is owned by the pg driver
 * adapter in `lib/db.ts`.
 *
 * Env loading is explicit and deliberately best-effort. The places the CLI runs
 * already differ:
 *
 *   - Docker (`docker-entrypoint.sh`) and CI pass DATABASE_URL as a real
 *     environment variable and ship no `.env` file at all.
 *   - A developer following the README has a `.env`, and expects
 *     `npm run prisma:migrate` to pick it up the way `next dev` does.
 *
 * `process.loadEnvFile()` is Node's built-in reader, so honouring `.env` costs
 * no dependency — dotenv would be one more package in the runtime tree purely
 * to parse a file that is absent in production. It throws when the file does
 * not exist, which is the normal case in a container, hence the catch.
 */
import { defineConfig } from "prisma/config";

try {
  process.loadEnvFile();
} catch {
  // No .env — the environment is expected to carry DATABASE_URL already.
}

// The `env()` helper from prisma/config resolves eagerly and throws when the
// variable is unset, which would make every CLI invocation require a database.
// `prisma generate` does not: the Docker builder stage generates the client
// with no DATABASE_URL in scope, and `npm run build` does the same on a
// developer's machine before the database exists. So the datasource is only
// attached when there is actually a URL to attach, and the commands that do
// need one (`migrate`, `db push`) fail with Prisma's own "missing datasource"
// message rather than a config-load error that names neither the command nor
// the variable.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
