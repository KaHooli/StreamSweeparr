import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { createSession, SESSION_COOKIE } from "@/lib/session";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-that-is-long-enough-1234";
});

const ORIGIN = "https://sweep.test";

function request(path: string, token?: string) {
  const req = new NextRequest(new URL(path, ORIGIN));
  if (token) req.cookies.set(SESSION_COOKIE, token);
  return req;
}

/** `NextResponse.next()` is the "carry on" signal; it sets no status of its own. */
function isPassThrough(res: Response) {
  return res.headers.has("x-middleware-next");
}

function redirectTarget(res: Response) {
  const loc = res.headers.get("location");
  return loc ? new URL(loc).pathname : null;
}

describe("proxy auth gate", () => {
  it("redirects an anonymous page request to the login page, keeping the target", async () => {
    const res = await proxy(request("/runs?tab=all"));
    expect(redirectTarget(res)).toBe("/login");
    expect(new URL(res.headers.get("location")!).searchParams.get("next")).toBe("/runs?tab=all");
  });

  it("answers an anonymous API request with 401 rather than a redirect", async () => {
    const res = await proxy(request("/api/dashboard"));
    expect(res.status).toBe(401);
  });

  it("lets a signed-in user through", async () => {
    const token = await createSession({ id: 1, username: "admin", role: "ADMIN" }, "local");
    expect(isPassThrough(await proxy(request("/runs", token)))).toBe(true);
  });

  it("holds a must-change-password session on the change-password flow", async () => {
    const token = await createSession(
      { id: 1, username: "admin", role: "ADMIN", mustChangePassword: true },
      "local"
    );
    expect(redirectTarget(await proxy(request("/settings", token)))).toBe("/change-password");
    expect(isPassThrough(await proxy(request("/change-password", token)))).toBe(true);
  });
});

describe("proxy PWA assets", () => {
  // The browser fetches the manifest and the worker script without credentials
  // (and fetches both from the login page, where there is no session yet), so
  // gating them breaks installability outright rather than degrading it.
  const publicAssets = [
    "/manifest.webmanifest",
    "/sw.js",
    "/offline.html",
    "/icons/pwa-192x192.png",
    "/icons/pwa-512x512-maskable.png",
    "/icons/apple-touch-icon-180x180.png",
    "/favicon.ico",
  ];

  for (const path of publicAssets) {
    it(`serves ${path} to an anonymous request`, async () => {
      expect(isPassThrough(await proxy(request(path)))).toBe(true);
    });
  }

  it("serves them during a forced password change too", async () => {
    const token = await createSession(
      { id: 1, username: "admin", role: "ADMIN", mustChangePassword: true },
      "local"
    );
    for (const path of publicAssets) {
      expect(isPassThrough(await proxy(request(path, token)))).toBe(true);
    }
  });

  it("does not open up anything beyond those static files", async () => {
    // The icons rule is a prefix match; make sure it cannot be walked out of,
    // and that neighbouring paths did not become public by accident.
    for (const path of ["/iconsdata", "/api/settings", "/settings", "/sw.js.map", "/"]) {
      expect(isPassThrough(await proxy(request(path)))).toBe(false);
    }
  });
});
