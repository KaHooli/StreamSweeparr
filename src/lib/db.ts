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
 */
export async function getSettings() {
  const existing = await prisma.settings.findUnique({
    where: { id: 1 },
    include: { connections: true },
  });
  if (existing) return existing;
  return prisma.settings.create({
    data: { id: 1 },
    include: { connections: true },
  });
}
