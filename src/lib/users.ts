/**
 * User provisioning helpers (Node runtime).
 *
 * There is exactly one local (username/password) account and it is always an
 * ADMIN. Its credentials can be supplied via environment variables — handy for
 * container deployments and as a password-recovery path. Users provisioned via
 * OIDC start as USER and can be promoted by an admin.
 */
import { prisma } from "./db";
import { hashPassword, verifyPassword } from "./password";

export const DEFAULT_ADMIN_USERNAME = "admin";
export const DEFAULT_ADMIN_PASSWORD = "0pen0pen&*";

function envUsername(): string | null {
  const v = process.env.ADMIN_USERNAME?.trim();
  return v ? v : null;
}
function envPassword(): string | null {
  const v = process.env.ADMIN_PASSWORD;
  return v && v.length > 0 ? v : null;
}

/**
 * Ensure the single local admin account exists and matches any credentials
 * supplied via environment variables.
 *
 * - First run: creates the account using ADMIN_USERNAME / ADMIN_PASSWORD when
 *   provided, otherwise the documented defaults (admin / 0pen0pen&*). The
 *   forced password change is only applied when falling back to the default
 *   password — if you set the password yourself there is nothing to fix.
 * - Later runs: ADMIN_USERNAME / ADMIN_PASSWORD remain authoritative while they
 *   are set, so the credentials in your compose file always work (and give you
 *   a way back in if you forget the password). Unset them to manage the
 *   username/password entirely in the UI.
 */
export async function ensureLocalAdmin() {
  const wantUsername = envUsername();
  const wantPassword = envPassword();

  // The local account is the one with a password hash (OIDC users have none).
  const local = await prisma.user.findFirst({
    where: { passwordHash: { not: null } },
    orderBy: { id: "asc" },
  });

  if (!local) {
    // Nothing local yet — create it. Avoid colliding with an existing OIDC
    // username by suffixing if necessary.
    const base = wantUsername ?? DEFAULT_ADMIN_USERNAME;
    let username = base;
    for (let i = 2; await prisma.user.findUnique({ where: { username } }); i++) {
      username = `${base}${i}`;
    }
    await prisma.user.create({
      data: {
        username,
        passwordHash: await hashPassword(wantPassword ?? DEFAULT_ADMIN_PASSWORD),
        role: "ADMIN",
        // Only force a change when using the well-known default password.
        mustChangePassword: !wantPassword,
      },
    });
    return;
  }

  const data: Record<string, unknown> = {};

  // Keep the local account an admin no matter what.
  if (local.role !== "ADMIN") data.role = "ADMIN";

  // Env username is authoritative while set (unless taken by another account).
  if (wantUsername && local.username !== wantUsername) {
    const clash = await prisma.user.findUnique({ where: { username: wantUsername } });
    if (!clash || clash.id === local.id) data.username = wantUsername;
  }

  // Env password is authoritative while set. Only rewrite when it differs, so
  // we don't churn the hash on every boot.
  if (wantPassword) {
    const matches = await verifyPassword(wantPassword, local.passwordHash);
    if (!matches) {
      data.passwordHash = await hashPassword(wantPassword);
      data.mustChangePassword = false;
    } else if (local.mustChangePassword) {
      // Password came from the environment — nothing for the user to fix.
      data.mustChangePassword = false;
    }
  }

  if (Object.keys(data).length) {
    await prisma.user.update({ where: { id: local.id }, data });
  }
}

/** Back-compat alias used by the login route. */
export const ensureDefaultAdmin = ensureLocalAdmin;

/**
 * Find or create a user for a successful OIDC login. Matches by oidcSubject
 * first, then by username (to link an existing account), otherwise creates a
 * new OIDC user with the USER role.
 */
export async function upsertOidcUser(opts: { subject: string; username: string }) {
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
      // New OIDC users are always plain users; an admin can promote them.
      role: "USER",
      passwordHash: null,
    },
  });
}
