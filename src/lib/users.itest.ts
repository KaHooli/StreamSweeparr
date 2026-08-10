import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import {
  ensureLocalAdmin,
  upsertOidcUser,
  DEFAULT_ADMIN_USERNAME,
  DEFAULT_ADMIN_PASSWORD,
} from "@/lib/users";
import { verifyPassword } from "@/lib/password";
import { resetDatabase } from "@/test/dbHelpers";

/**
 * User provisioning is the one path that can lock an admin out of their own
 * install, or quietly let an OIDC login land on somebody else's account. Both
 * of those live in `findUnique`/`update` sequences against real unique
 * constraints, so they are tested against a real database rather than a mock.
 */

beforeEach(async () => {
  await resetDatabase();
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** The single local (password-holding) account. */
function localAdmin() {
  return prisma.user.findFirst({ where: { passwordHash: { not: null } }, orderBy: { id: "asc" } });
}

describe("ensureLocalAdmin", () => {
  it("creates the documented default account on a fresh install", async () => {
    await ensureLocalAdmin();
    const admin = await localAdmin();
    expect(admin).toMatchObject({
      username: DEFAULT_ADMIN_USERNAME,
      role: "ADMIN",
      // The default password is public knowledge, so it must be changed.
      mustChangePassword: true,
    });
    expect(await verifyPassword(DEFAULT_ADMIN_PASSWORD, admin!.passwordHash)).toBe(true);
  });

  it("uses the environment credentials and does not force a change", async () => {
    process.env.ADMIN_USERNAME = "ada";
    process.env.ADMIN_PASSWORD = "correct horse battery staple";
    await ensureLocalAdmin();
    const admin = await localAdmin();
    expect(admin).toMatchObject({ username: "ada", role: "ADMIN", mustChangePassword: false });
    expect(await verifyPassword("correct horse battery staple", admin!.passwordHash)).toBe(true);
  });

  it("is idempotent and does not churn the hash across boots", async () => {
    process.env.ADMIN_USERNAME = "ada";
    process.env.ADMIN_PASSWORD = "pw";
    await ensureLocalAdmin();
    const first = await localAdmin();
    await ensureLocalAdmin();
    const second = await localAdmin();
    expect(second!.passwordHash).toBe(first!.passwordHash);
    expect(second!.tokenVersion).toBe(first!.tokenVersion);
  });

  // The recovery path: change the password in the compose file, get back in.
  it("adopts a changed environment password and invalidates old sessions", async () => {
    process.env.ADMIN_PASSWORD = "first";
    await ensureLocalAdmin();
    const before = await localAdmin();

    process.env.ADMIN_PASSWORD = "second";
    await ensureLocalAdmin();
    const after = await localAdmin();

    expect(await verifyPassword("second", after!.passwordHash)).toBe(true);
    // A rotated password must not leave sessions minted against the old one
    // still valid — that is the whole point of the recovery path.
    expect(after!.tokenVersion).toBe(before!.tokenVersion + 1);
    expect(after!.mustChangePassword).toBe(false);
  });

  it("clears the forced change once a password comes from the environment", async () => {
    await ensureLocalAdmin();
    expect((await localAdmin())!.mustChangePassword).toBe(true);

    process.env.ADMIN_PASSWORD = DEFAULT_ADMIN_PASSWORD;
    await ensureLocalAdmin();
    // Same password, so no rehash — but it is now an explicit choice.
    expect((await localAdmin())!.mustChangePassword).toBe(false);
  });

  it("restores the ADMIN role if the local account was demoted", async () => {
    await ensureLocalAdmin();
    const admin = await localAdmin();
    await prisma.user.update({ where: { id: admin!.id }, data: { role: "USER" } });
    await ensureLocalAdmin();
    expect((await localAdmin())!.role).toBe("ADMIN");
  });

  it("sidesteps a username already taken by an OIDC account", async () => {
    await upsertOidcUser({ subject: "sub-1", username: DEFAULT_ADMIN_USERNAME });
    await ensureLocalAdmin();
    const admin = await localAdmin();
    // Suffixed rather than colliding — the unique constraint would otherwise
    // make the local account impossible to create at all.
    expect(admin!.username).toBe(`${DEFAULT_ADMIN_USERNAME}2`);
    expect(admin!.role).toBe("ADMIN");
  });

  it("refuses to rename onto a username another account holds", async () => {
    await ensureLocalAdmin();
    await upsertOidcUser({ subject: "sub-1", username: "taken" });
    process.env.ADMIN_USERNAME = "taken";
    await ensureLocalAdmin();
    // The rename is skipped rather than throwing a unique-constraint error.
    expect((await localAdmin())!.username).toBe(DEFAULT_ADMIN_USERNAME);
  });
});

describe("upsertOidcUser", () => {
  it("creates a new OIDC user with the USER role and no password", async () => {
    const user = await upsertOidcUser({ subject: "sub-1", username: "ada" });
    expect(user).toMatchObject({ username: "ada", role: "USER", passwordHash: null });
  });

  it("returns the same account on a second login", async () => {
    const first = await upsertOidcUser({ subject: "sub-1", username: "ada" });
    const second = await upsertOidcUser({ subject: "sub-1", username: "ada" });
    expect(second.id).toBe(first.id);
  });

  // The subject is the stable identity; a renamed user must not become a new
  // account (and lose their role with it).
  it("follows the subject when the provider renames the user", async () => {
    const first = await upsertOidcUser({ subject: "sub-1", username: "ada" });
    const renamed = await upsertOidcUser({ subject: "sub-1", username: "ada.lovelace" });
    expect(renamed.id).toBe(first.id);
    expect(renamed.username).toBe("ada");
  });

  it("links an existing local account by username on first SSO login", async () => {
    await ensureLocalAdmin();
    const admin = await localAdmin();
    const linked = await upsertOidcUser({ subject: "sub-1", username: admin!.username });
    expect(linked.id).toBe(admin!.id);
    expect(linked.oidcSubject).toBe("sub-1");
    // Linking must not demote the admin or drop their password.
    expect(linked.role).toBe("ADMIN");
    expect(linked.passwordHash).not.toBeNull();
  });

  it("keeps two different subjects as two different accounts", async () => {
    const a = await upsertOidcUser({ subject: "sub-1", username: "ada" });
    const b = await upsertOidcUser({ subject: "sub-2", username: "eve" });
    expect(a.id).not.toBe(b.id);
  });
});
