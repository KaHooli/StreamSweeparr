import { describe, it, expect, afterAll } from "vitest";

/**
 * The `?schema=` parameter, verified against a real database.
 *
 * `dbConfig.test.ts` proves the parameter is read out of the URL. What it
 * cannot prove is the part that actually matters: that handing it to `PrismaPg`
 * changes which schema the queries address.
 *
 * This is worth a real database because the failure mode is silent. `pg` does
 * not understand `?schema=` and ignores it, so an adapter built without the
 * option does not error — it quietly runs every query against whatever the
 * connection's search_path resolves to. On the usual install that is `public`
 * and nothing looks wrong, which is exactly why a regression here would reach a
 * release: it only bites the installs that set the parameter to something else,
 * and it presents to them as an empty library rather than as a fault.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { resolveAdapterConfig } from "@/lib/dbConfig";

const SCHEMA = "dbconfig_itest";

// Built from the suite's own URL so this follows the database the runner was
// pointed at, rather than inventing a second set of credentials.
function urlWithSchema(schema: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("schema", schema);
  return url.toString();
}

function clientFor(url: string, schema: string | undefined): PrismaClient {
  const adapter = new PrismaPg({ connectionString: url }, { schema });
  return new PrismaClient({ adapter });
}

// A throwaway client on the suite's default connection, used only to build and
// tear down the alternate schema.
const admin = clientFor(process.env.DATABASE_URL!, resolveAdapterConfig(process.env.DATABASE_URL, 1).schema);

afterAll(async () => {
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.$disconnect();
});

describe("the schema parameter", () => {
  it("addresses the schema named in DATABASE_URL, not the search_path default", async () => {
    // A second "Settings" table in its own schema, holding a row id that the
    // real one never has (the app's Settings row is always id = 1).
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.$executeRawUnsafe(
      `CREATE TABLE "${SCHEMA}"."Settings" (LIKE public."Settings" INCLUDING ALL)`,
    );
    // `updatedAt` is Prisma's @updatedAt, which is applied client-side and so
    // has no database default to fall back on in a raw insert.
    await admin.$executeRawUnsafe(
      `INSERT INTO "${SCHEMA}"."Settings" (id, "updatedAt") VALUES (99, NOW())`,
    );

    const config = resolveAdapterConfig(urlWithSchema(SCHEMA), 1);
    expect(config.schema).toBe(SCHEMA);

    const scoped = clientFor(urlWithSchema(SCHEMA), config.schema);
    try {
      const rows = await scoped.settings.findMany({ select: { id: true } });
      // The row only exists in the alternate schema. Seeing it proves the query
      // was routed there; an adapter that ignored the parameter would have read
      // public."Settings" and found the app's own row, or none at all.
      expect(rows.map((r) => r.id)).toEqual([99]);
    } finally {
      await scoped.$disconnect();
    }
  });
});
