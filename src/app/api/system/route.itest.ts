import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Settings → Info is admin-only, and the tab being hidden in the UI is not what
 * makes it so — this route is. These tests drive the real handler with real
 * cookies to check that the guard, not the markup, is the boundary.
 */

let cookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => (cookieValue ? { value: cookieValue } : undefined) }),
}));

import { prisma } from "@/lib/db";
import { createSession } from "@/lib/session";
import { GET } from "./route";
import { resetDatabase, makeSettings } from "@/test/dbHelpers";

beforeEach(async () => {
  await resetDatabase();
  cookieValue = undefined;
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function signInAs(role: "ADMIN" | "USER") {
  const user = await prisma.user.create({
    data: { username: `${role.toLowerCase()}-user`, role, passwordHash: "x" },
  });
  cookieValue = await createSession(user, "local");
  return user;
}

describe("GET /api/system", () => {
  it("refuses anonymous callers", async () => {
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("refuses signed-in non-administrators", async () => {
    await signInAs("USER");
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("serves the full payload to an administrator", async () => {
    await signInAs("ADMIN");
    await makeSettings();

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = await res.json();
    expect(body.app.nodeVersion).toBe(process.version);
    expect(body.database.reachable).toBe(true);
    expect(body.library.admins).toBe(1);
    expect(body.config).not.toBeNull();
    expect(body.env).toBeTruthy();
  });

  it("stops honouring a token once the account is demoted", async () => {
    // The tab could still be on screen from before the demotion; the data
    // behind it must not be.
    const user = await signInAs("ADMIN");
    expect((await GET()).status).toBe(200);

    await prisma.user.update({
      where: { id: user.id },
      data: { role: "USER", tokenVersion: { increment: 1 } },
    });

    // A bumped tokenVersion invalidates the session outright.
    expect((await GET()).status).toBe(401);
  });

  it("never returns a stored API key", async () => {
    await signInAs("ADMIN");
    await makeSettings({ watchmodeApiKey: "wm-live-key-should-not-appear" });

    const res = await GET();
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("wm-live-key-should-not-appear");
    expect(text).toContain('"watchmodeApiKeySet"');
  });
});
