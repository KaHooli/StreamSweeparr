import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("s3cret-pass");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("s3cret-pass", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("s3cret-pass");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("rejects when there is no stored hash", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
  });

  it("produces a unique salt per hash", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });
});
