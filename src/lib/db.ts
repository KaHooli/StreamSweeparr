import os from "node:os";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { decryptSettingsRow, decryptConnection } from "./secrets";
import { watchmodeKeys } from "./watchmodeKeys";
import { resolveAdapterConfig, type AdapterConfig } from "./dbConfig";

/**
 * The configuration `pg` was actually built with.
 *
 * Prisma 7 has no pool of its own — the driver adapter owns it — so this is the
 * only place that knows the real numbers. Settings → Info reports them from
 * here rather than re-reading `DATABASE_URL`, because the URL only says what
 * was *asked for*: it is silent about the defaults that apply when the
 * parameters are absent, which is the case on almost every install.
 */
export const adapterConfig: AdapterConfig = resolveAdapterConfig(
  process.env.DATABASE_URL,
  os.cpus().length,
);

// Reuse the Prisma client across hot reloads / lambda invocations. This matters
// more under Prisma 7 than it did before: the client now owns a `pg` pool, so a
// client leaked per hot reload leaks sockets to Postgres rather than just heap.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Build the client on the pg driver adapter.
 *
 * Prisma 7 removed the Rust query engine, so an adapter is mandatory and the
 * connection string is read here rather than from `schema.prisma`. Passing a
 * config object rather than the bare URL string is what lets the pool settings
 * above take effect — handed a string, `PrismaPg` builds a pool on `pg`'s own
 * defaults, including waiting forever for a connection that never frees up.
 */
function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg(
    {
      connectionString: process.env.DATABASE_URL,
      max: adapterConfig.max,
      connectionTimeoutMillis: adapterConfig.connectionTimeoutMillis,
      idleTimeoutMillis: adapterConfig.idleTimeoutMillis,
    },
    // `schema` is the adapter's option, not the pool's: `pg` has no idea what
    // the `?schema=` in the URL means and would leave queries on whatever the
    // connection's search_path happens to be.
    { schema: adapterConfig.schema },
  );
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

type SettingsWithConnections = NonNullable<
  Awaited<ReturnType<typeof findSettingsRow>>
>;

function findSettingsRow() {
  return prisma.settings.findUnique({
    where: { id: 1 },
    include: { connections: true },
  });
}

/**
 * Decrypt the credentials on a settings row and its connections.
 *
 * Every read of a stored credential goes through `getSettings`, so decrypting
 * here is what keeps the rest of the app unaware that encryption exists — it
 * asks for `settings.watchmodeApiKey` and gets a usable key.
 *
 * `watchmodeApiKeys` is normalised here too: it is the source of truth for the
 * Watchmode key ring, and `watchmodeApiKey` is derived from its first element
 * so the many callers that only ask "is Watchmode configured?" keep working.
 * An install still carrying only the legacy column folds into a one-key ring.
 */
function decryptSettings(row: SettingsWithConnections): SettingsWithConnections {
  const decrypted = decryptSettingsRow(row);
  const keys = watchmodeKeys(decrypted);
  return {
    ...decrypted,
    watchmodeApiKeys: keys,
    watchmodeApiKey: keys[0] ?? null,
    connections: row.connections.map(decryptConnection),
  };
}

/**
 * Return the single Settings row, creating it with defaults if it does not
 * exist yet. The app is single-tenant, so id is always 1.
 *
 * This must be safe under concurrency: a page like Settings fires several
 * requests in parallel and each one calls this. A naive find-then-create races —
 * on a fresh database multiple callers see "not found" and all try to insert
 * id=1, so every loser fails with a unique-constraint error (P2002) and returns
 * a 500. We therefore treat "already exists" as success and re-read.
 *
 * Credentials come back decrypted; see `lib/secrets.ts`.
 */
export async function getSettings(): Promise<SettingsWithConnections> {
  const existing = await findSettingsRow();
  if (existing) return decryptSettings(existing);

  try {
    const created = await prisma.settings.create({
      data: { id: 1 },
      include: { connections: true },
    });
    return decryptSettings(created);
  } catch (e) {
    // P2002 = unique constraint violation → another request created it first.
    const code = (e as { code?: string }).code;
    if (code === "P2002" || code === "P2010") {
      const row = await findSettingsRow();
      if (row) return decryptSettings(row);
    }
    throw e;
  }
}

/**
 * The settings row exactly as stored, credentials still encrypted.
 *
 * Only for code that must reason about the stored form — the boot-time
 * migration, and the settings API deciding whether a credential is present but
 * unreadable. Everything else wants `getSettings`.
 */
export function getRawSettings() {
  return findSettingsRow();
}
