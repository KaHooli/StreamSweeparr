/**
 * User provisioning helpers (Node runtime).
 */
import { prisma } from "./db";
import { hashPassword } from "./password";

export const DEFAULT_ADMIN_USERNAME = "admin";
export const DEFAULT_ADMIN_PASSWORD = "0pen0pen&*";

/**
 * Ensure the default admin exists. Called lazily on the first login attempt so
 * a fresh install can be accessed with admin / 0pen0pen&*. The user is flagged
 * `mustChangePassword` until they set their own password.
 */
export async function ensureDefaultAdmin() {
  const count = await prisma.user.count();
  if (count > 0) return;
  await prisma.user.create({
    data: {
      username: DEFAULT_ADMIN_USERNAME,
      passwordHash: await hashPassword(DEFAULT_ADMIN_PASSWORD),
      isAdmin: true,
      mustChangePassword: true,
    },
  });
}

/**
 * Find or create a user for a successful OIDC login. Matches by oidcSubject
 * first, then by username (to link an existing local admin), otherwise creates
 * a new OIDC-only user.
 */
export async function upsertOidcUser(opts: {
  subject: string;
  username: string;
}) {
  const bySub = await prisma.user.findUnique({ where: { oidcSubject: opts.subject } });
  if (bySub) return bySub;

  const byName = await prisma.user.findUnique({ where: { username: opts.username } });
  if (byName) {
    return prisma.user.update({
      where: { id: byName.id },
      data: { oidcSubject: opts.subject },
    });
  }

  return prisma.user.create({
    data: {
      username: opts.username,
      oidcSubject: opts.subject,
      isAdmin: true,
      passwordHash: null,
    },
  });
}
