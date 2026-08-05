import { describe, it, expect } from "vitest";
import {
  checkRateLimit,
  registerFailure,
  resetRateLimit,
  DEFAULT_POLICY,
  GLOBAL_POLICY,
} from "./ratelimit";

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

  it("backs off exponentially, up to the policy's cap", () => {
    const key = `test:${Math.random()}`;
    let previous = 0;
    for (let i = 0; i < DEFAULT_POLICY.maxFails + 4; i++) {
      const r = registerFailure(key);
      if (!r.allowed) {
        expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(previous);
        previous = r.retryAfterSeconds;
      }
    }
    expect(previous).toBeLessThanOrEqual(DEFAULT_POLICY.maxLockMs / 1000);
  });

  it("tolerates far more failures under the global policy than the default one", () => {
    const key = `test:global:${Math.random()}`;
    // The instance-wide bucket exists to catch an attacker rotating identities;
    // it must not trip on a handful of ordinary typos.
    for (let i = 0; i < DEFAULT_POLICY.maxFails + 5; i++) {
      registerFailure(key, GLOBAL_POLICY);
    }
    expect(checkRateLimit(key).allowed).toBe(true);

    for (let i = 0; i < GLOBAL_POLICY.maxFails; i++) registerFailure(key, GLOBAL_POLICY);
    expect(checkRateLimit(key).allowed).toBe(false);
  });
});
