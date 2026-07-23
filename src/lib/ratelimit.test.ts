import { describe, it, expect } from "vitest";
import { checkRateLimit, registerFailure, resetRateLimit } from "./ratelimit";

describe("rate limiter", () => {
  it("allows initially and locks out after repeated failures", () => {
    const key = `test:${Math.random()}`;
    expect(checkRateLimit(key).allowed).toBe(true);

    // Below the threshold: still allowed.
    for (let i = 0; i < 4; i++) registerFailure(key);
    expect(checkRateLimit(key).allowed).toBe(true);

    // Crossing the threshold triggers a lockout.
    const res = registerFailure(key);
    expect(res.allowed).toBe(false);
    expect(res.retryAfterSeconds).toBeGreaterThan(0);
    expect(checkRateLimit(key).allowed).toBe(false);
  });

  it("resets on success", () => {
    const key = `test:${Math.random()}`;
    for (let i = 0; i < 6; i++) registerFailure(key);
    expect(checkRateLimit(key).allowed).toBe(false);
    resetRateLimit(key);
    expect(checkRateLimit(key).allowed).toBe(true);
  });
});
