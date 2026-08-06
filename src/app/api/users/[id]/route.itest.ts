import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * End-to-end check of the admin user routes against a real database.
 *
 * The point of interest is revocation: a session token is signed, not stored,
 * so demoting or deleting an account only means something if the guard notices.
 * These tests drive the real route handlers with a real cookie and then ask
 * whether that cookie still carries any authority.
 */

let cookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => (cookieValue ? { value: cookieValue } : undefined) }),
}));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { createSession, verifySession } from "@/lib/session";
import { resolveSession } from "@/lib/auth";
import { PATCH, DELETE } from "./route";
import { resetDatabase } from "@/test/dbHelpers";

beforeEach(async () => {
  await resetDatabase();
  cookieValue = undefined;
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function makeUser(over: {
  username: string;
  role?: "ADMIN" | "USER";
  passwordHash?: string | null;
  oidcSubject?: string | null;
}) {
  return prisma.user.create({
    data: {
      username: over.username,
      role: over.role ?? "USER",
      passwordHash: over.passwordHash ?? null,
      oidcSubject: over.oidcSubject ?? null,
    },
  });
}

async function signIn(user: { id: number; username: string; role: "ADMIN" | "USER"; tokenVersion: number }) {
  return createSession(user, "local");
}

const req = (body: unknown) =>
  new NextRequest("http://localhost/api/users/1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

// Next 16 hands route params to the handler as a Promise, so the test has to
// supply one too — otherwise it would pass a shape the real router never sends.
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

/** Whether a token still resolves to an honoured session. */
async function stillValid(token: string) {
  return (await resolveSession(await verifySession(token))) !== null;
}

describe("PATCH /api/users/[id] — role changes", () => {
  it("promotes a user and invalidates their existing sessions", async () => {
    const admin = await makeUser({ username: "admin", role: "ADMIN", passwordHash: "scrypt$a$b" });
    const target = await makeUser({ username: "bob", oidcSubject: "sub-bob" });
    const bobToken = await signIn(target);
    cookieValue = await signIn(admin);

    expect(await stillValid(bobToken)).toBe(true);

    const res = await PATCH(req({ role: "ADMIN" }), ctx(target.id));
    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe("ADMIN");

    // Bob's old cookie is dead: it was minted at the previous tokenVersion.
    expect(await stillValid(bobToken)).toBe(false);
  });

  it("strips admin rights from a demoted user's live session immediately", async () => {
    const admin = await makeUser({ username: "admin", role: "ADMIN", passwordHash: "scrypt$a$b" });
    const other = await makeUser({ username: "carol", role: "ADMIN", oidcSubject: "sub-carol" });
    const carolToken = await signIn(other);
    cookieValue = await signIn(admin);

    await PATCH(req({ role: "USER" }), ctx(other.id));

    // Before tokenVersion existed this cookie kept ADMIN for up to seven days.
    expect(await stillValid(carolToken)).toBe(false);
  });

  it("refuses to demote the local username/password account", async () => {
    const admin = await makeUser({ username: "admin", role: "ADMIN", passwordHash: "scrypt$a$b" });
    cookieValue = await signIn(admin);

    const res = await PATCH(req({ role: "USER" }), ctx(admin.id));
    expect(res.status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe("ADMIN");
  });

  it("refuses to remove the last administrator", async () => {
    const admin = await makeUser({ username: "sso-admin", role: "ADMIN", oidcSubject: "sub-a" });
    cookieValue = await signIn(admin);

    const res = await PATCH(req({ role: "USER" }), ctx(admin.id));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("administrator") });
  });

  it("rejects an unknown user and a bad role", async () => {
    const admin = await makeUser({ username: "admin", role: "ADMIN", passwordHash: "scrypt$a$b" });
    cookieValue = await signIn(admin);

    expect((await PATCH(req({ role: "ADMIN" }), ctx(9999))).status).toBe(404);
    expect((await PATCH(req({ role: "WIZARD" }), ctx(admin.id))).status).toBe(400);
  });

  it("is closed to non-admins and to anonymous callers", async () => {
    const plain = await makeUser({ username: "dave", oidcSubject: "sub-dave" });
    cookieValue = await signIn(plain);
    expect((await PATCH(req({ role: "ADMIN" }), ctx(plain.id))).status).toBe(403);

    cookieValue = undefined;
    expect((await PATCH(req({ role: "ADMIN" }), ctx(plain.id))).status).toBe(401);
  });
});

describe("DELETE /api/users/[id]", () => {
  const del = () =>
    new NextRequest("http://localhost/api/users/1", { method: "DELETE" });

  it("removes an OIDC account and kills its session", async () => {
    const admin = await makeUser({ username: "admin", role: "ADMIN", passwordHash: "scrypt$a$b" });
    const target = await makeUser({ username: "erin", oidcSubject: "sub-erin" });
    const erinToken = await signIn(target);
    cookieValue = await signIn(admin);

    const res = await DELETE(del(), ctx(target.id));
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: target.id } })).toBeNull();
    // The guard has to notice the account is simply gone.
    expect(await stillValid(erinToken)).toBe(false);
  });

  it("refuses to delete the local account or yourself", async () => {
    const admin = await makeUser({ username: "admin", role: "ADMIN", passwordHash: "scrypt$a$b" });
    const selfOidc = await makeUser({ username: "frank", role: "ADMIN", oidcSubject: "sub-frank" });

    cookieValue = await signIn(selfOidc);
    expect((await DELETE(del(), ctx(admin.id))).status).toBe(400); // local account
    expect((await DELETE(del(), ctx(selfOidc.id))).status).toBe(400); // self
    expect(await prisma.user.count()).toBe(2);
  });
});
