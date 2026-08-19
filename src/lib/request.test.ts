import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { configuredPublicUrl } from "./request";

describe("configuredPublicUrl", () => {
  // The rejection paths log a warning, which is the point of them — but it is
  // noise in the test output, so swallow it rather than reading past it.
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.PUBLIC_URL;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("returns null when PUBLIC_URL is unset or blank", () => {
    expect(configuredPublicUrl()).toBeNull();
    process.env.PUBLIC_URL = "   ";
    expect(configuredPublicUrl()).toBeNull();
  });

  it("parses an absolute http(s) URL", () => {
    process.env.PUBLIC_URL = "https://sweep.example.com";
    expect(configuredPublicUrl()?.href).toBe("https://sweep.example.com/");

    process.env.PUBLIC_URL = "http://nas.local:3000";
    expect(configuredPublicUrl()?.href).toBe("http://nas.local:3000/");
  });

  it("keeps the path, so a subpath deployment resolves metadata under it", () => {
    process.env.PUBLIC_URL = "https://example.com/streamsweeparr";
    expect(configuredPublicUrl()?.pathname).toBe("/streamsweeparr");
  });

  it("ignores a malformed value rather than throwing", () => {
    // Callers run at module scope, where throwing would fail the whole boot.
    process.env.PUBLIC_URL = "sweep.example.com";
    expect(configuredPublicUrl()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("ignores a non-http(s) scheme", () => {
    process.env.PUBLIC_URL = "ftp://example.com";
    expect(configuredPublicUrl()).toBeNull();

    process.env.PUBLIC_URL = "javascript:alert(1)";
    expect(configuredPublicUrl()).toBeNull();
  });
});
