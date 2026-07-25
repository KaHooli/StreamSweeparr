import { PrismaClient } from "@prisma/client";

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

/**
 * Return the single Settings row, creating it with defaults if it does not
 * exist yet. The app is single-tenant, so id is always 1.
 *
 * This must be safe under concurrency: a page like Settings fires several
 * requests in parallel and each one calls this. A naive find-then-create races —
 * on a fresh database multiple callers see "not found" and all try to insert
 * id=1, so every loser fails with a unique-constraint error (P2002) and returns
 * a 500. We therefore treat "already exists" as success and re-read.
 */
export async function getSettings() {
  const existing = await prisma.settings.findUnique({
    where: { id: 1 },
    include: { connections: true },
  });
  if (existing) return existing;

  try {
    return await prisma.settings.create({
      data: { id: 1 },
      include: { connections: true },
    });
  } catch (e) {
    // P2002 = unique constraint violation → another request created it first.
    const code = (e as { code?: string }).code;
    if (code === "P2002" || code === "P2010") {
      const row = await prisma.settings.findUnique({
        where: { id: 1 },
        include: { connections: true },
      });
      if (row) return row;
    }
    throw e;
  }
}
