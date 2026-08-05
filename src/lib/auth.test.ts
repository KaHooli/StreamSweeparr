import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The guards are the only place that can tell "this cookie is signed" from
 * "this account may still do that". The middleware runs on the edge with no
 * database, so everything below is what actually stops a deleted or demoted
 * account from acting.
 */

interface StoredUser {
  id: number;
  username: string;
  role: "ADMIN" | "USER";
  tokenVersion: number;
  mustChangePassword: boolean;
}

let stored: StoredUser | null = null;
let cookieValue: string | undefined;

vi.mock("./db", () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: number } }) =>
        stored && stored.id === where.id ? stored : null,
    },
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => (cookieValue ? { value: cookieValue } : undefined) }),
}));

import { resolveSession, requireSession, requireAdmin, AuthError, withGuard } from "./auth";
import { createSession, type SessionPayload } from "./session";

process.env.AUTH_SECRET = "test-secret-that-is-long-enough-1234";

const payload = (over: Partial<SessionPayload> = {}): SessionPayload => ({
  sub: 1,
  username: "admin",
  role: "ADMIN",
  method: "local",
  ver: 0,
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...over,
});

beforeEach(() => {
  stored = {
    id: 1,
    username: "admin",
    role: "ADMIN",
    tokenVersion: 0,
    mustChangePassword: false,
  };
  cookieValue = undefined;
});

describe("resolveSession", () => {
  it("accepts a token matching the stored account", async () => {
    expect(await resolveSession(payload())).toMatchObject({ sub: 1, role: "ADMIN" });
  });

  it("rejects a token for an account that no longer exists", async () => {
    stored = null;
    expect(await resolveSession(payload())).toBeNull();
  });

  it("rejects a token minted before the account's tokenVersion", async () => {
    stored!.tokenVersion = 1;
    expect(await resolveSession(payload({ ver: 0 }))).toBeNull();
  });

  it("accepts pre-upgrade tokens that carry no version", async () => {
    const legacy = payload();
    delete legacy.ver;
    expect(await resolveSession(legacy)).not.toBeNull();
  });

  it("reports the stored role, not the role baked into the token", async () => {
    // The demotion happened after this token was signed.
    stored!.role = "USER";
    const resolved = await resolveSession(payload({ role: "ADMIN" }));
    expect(resolved!.role).toBe("USER");
  });

  it("reports the stored username and password-change flag", async () => {
    stored!.username = "renamed";
    stored!.mustChangePassword = true;
    const resolved = await resolveSession(payload({ username: "admin" }));
    expect(resolved!.username).toBe("renamed");
    expect(resolved!.mustChangePassword).toBe(true);
  });

  it("rejects a null token", async () => {
    expect(await resolveSession(null)).toBeNull();
  });
});

describe("requireSession / requireAdmin", () => {
  it("throws 401 without a cookie", async () => {
    await expect(requireSession()).rejects.toMatchObject({ status: 401 });
  });

  it("throws 401 for a forged cookie", async () => {
    cookieValue = "not.a-real-token";
    await expect(requireSession()).rejects.toBeInstanceOf(AuthError);
  });

  it("accepts a freshly minted cookie", async () => {
    cookieValue = await createSession(
      { id: 1, username: "admin", role: "ADMIN", tokenVersion: 0 },
      "local"
    );
    await expect(requireSession()).resolves.toMatchObject({ sub: 1 });
  });

  it("rejects a cookie whose account was revoked after signing", async () => {
    cookieValue = await createSession(
      { id: 1, username: "admin", role: "ADMIN", tokenVersion: 0 },
      "local"
    );
    stored!.tokenVersion = 1; // e.g. password changed in another session
    await expect(requireSession()).rejects.toMatchObject({ status: 401 });
  });

  it("throws 403 for a demoted admin holding an ADMIN token", async () => {
    cookieValue = await createSession(
      { id: 1, username: "admin", role: "ADMIN", tokenVersion: 0 },
      "local"
    );
    stored!.role = "USER";
    await expect(requireAdmin()).rejects.toMatchObject({ status: 403 });
  });
});

describe("withGuard", () => {
  it("turns an AuthError into its JSON response and skips the handler", async () => {
    const handler = vi.fn();
    const route = withGuard(requireAdmin, handler);
    const res = await route();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not authenticated." });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes the resolved session to the handler", async () => {
    cookieValue = await createSession(
      { id: 1, username: "admin", role: "ADMIN", tokenVersion: 0 },
      "local"
    );
    const route = withGuard(requireAdmin, async (session) => {
      expect(session.sub).toBe(1);
      return new Response(null, { status: 204 }) as never;
    });
    expect((await route()).status).toBe(204);
  });
});
