// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { ServiceWorkerRegistrar } from "./ServiceWorkerRegistrar";

/**
 * The two branches here have opposite failure modes and neither one shows up in
 * a normal page render: forgetting to register leaves the app quietly
 * uninstallable, while registering in development leaves a worker caching build
 * assets in front of a dev server that rewrites them constantly.
 */

const registration = {
  waiting: null as { postMessage: ReturnType<typeof vi.fn> } | null,
  installing: null,
  addEventListener: vi.fn(),
};

let register: ReturnType<typeof vi.fn>;
let getRegistrations: ReturnType<typeof vi.fn>;
let unregister: ReturnType<typeof vi.fn>;

beforeEach(() => {
  registration.waiting = null;
  registration.addEventListener = vi.fn();
  register = vi.fn(async () => registration);
  unregister = vi.fn(async () => true);
  getRegistrations = vi.fn(async () => [{ unregister }]);

  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register, getRegistrations, controller: null },
  });
  // `load` has already fired in jsdom by the time the component mounts.
  Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

/** Mount and let the registration promises settle. */
async function mount() {
  await act(async () => {
    render(<ServiceWorkerRegistrar />);
  });
}

describe("ServiceWorkerRegistrar", () => {
  it("registers the worker at the root scope in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await mount();

    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(getRegistrations).not.toHaveBeenCalled();
  });

  it("hands over immediately to a worker that is already waiting", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const postMessage = vi.fn();
    registration.waiting = { postMessage };

    await mount();

    expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  });

  it("survives a browser that refuses to register", async () => {
    vi.stubEnv("NODE_ENV", "production");
    register.mockRejectedValue(new Error("insecure context"));

    await expect(mount()).resolves.toBeUndefined();
  });

  it("unregisters any leftover worker in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await mount();

    expect(register).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalled();
  });

  it("does nothing at all where service workers are unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // @ts-expect-error - deleting the property is the point
    delete navigator.serviceWorker;

    await expect(mount()).resolves.toBeUndefined();
  });
});
