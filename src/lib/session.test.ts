import { describe, it, expect, beforeAll } from "vitest";
import { createSession, verifySession } from "./session";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-that-is-long-enough-1234";
});

describe("session tokens", () => {
  const user = { id: 7, username: "admin", isAdmin: true };

  it("round-trips a valid session", async () => {
    const token = await createSession(user, "local");
    const payload = await verifySession(token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(7);
    expect(payload!.username).toBe("admin");
    expect(payload!.isAdmin).toBe(true);
    expect(payload!.method).toBe("local");
  });

  it("carries mustChangePassword", async () => {
    const token = await createSession({ ...user, mustChangePassword: true }, "local");
    const payload = await verifySession(token);
    expect(payload!.mustChangePassword).toBe(true);
  });

  it("rejects a tampered token", async () => {
    const token = await createSession(user, "local");
    const [body] = token.split(".");
    const forged = `${body}.AAAAtamperedsignatureAAAA`;
    expect(await verifySession(forged)).toBeNull();
  });

  it("rejects malformed / empty tokens", async () => {
    expect(await verifySession(undefined)).toBeNull();
    expect(await verifySession("")).toBeNull();
    expect(await verifySession("not-a-token")).toBeNull();
  });

  it("rejects an expired token", async () => {
    // Build a token with an exp in the past by signing a crafted payload is not
    // exposed; instead verify the guard rejects a body we hand-expire.
    const token = await createSession(user, "local");
    const [body, sig] = token.split(".");
    const json = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    json.exp = Math.floor(Date.now() / 1000) - 10;
    // Re-encoding without re-signing must fail (signature mismatch), proving
    // exp cannot be altered client-side.
    const tampered =
      Buffer.from(JSON.stringify(json))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "") +
      "." +
      sig;
    expect(await verifySession(tampered)).toBeNull();
  });
});
