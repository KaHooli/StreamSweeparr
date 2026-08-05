import { PrismaClient } from "@prisma/client";
import { decryptSettingsRow, decryptConnection } from "./secrets";

// Reuse the Prisma client across hot reloads / lambda invocations.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

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
 */
function decryptSettings(row: SettingsWithConnections): SettingsWithConnections {
  return {
    ...decryptSettingsRow(row),
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
