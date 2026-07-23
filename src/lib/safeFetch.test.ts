import { describe, it, expect, beforeEach } from "vitest";
import { assertUrlAllowed, SsrfError } from "./safeFetch";

describe("SSRF guard (assertUrlAllowed)", () => {
  beforeEach(() => {
    delete process.env.SSRF_ALLOW_PRIVATE;
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(assertUrlAllowed("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertUrlAllowed("ftp://example.com")).rejects.toBeInstanceOf(SsrfError);
  });

  it("always blocks loopback", async () => {
    await expect(assertUrlAllowed("http://127.0.0.1:8989")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertUrlAllowed("http://[::1]/")).rejects.toBeInstanceOf(SsrfError);
  });

  it("always blocks the cloud metadata address", async () => {
    await expect(assertUrlAllowed("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      SsrfError
    );
  });

  it("blocks private ranges by default", async () => {
    await expect(assertUrlAllowed("http://10.0.0.5")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertUrlAllowed("http://192.168.1.10:7878")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertUrlAllowed("http://172.16.5.5")).rejects.toBeInstanceOf(SsrfError);
  });

  it("allows private ranges when opted in, but still blocks loopback/metadata", async () => {
    process.env.SSRF_ALLOW_PRIVATE = "true";
    const url = await assertUrlAllowed("http://192.168.1.10:7878");
    expect(url.hostname).toBe("192.168.1.10");
    // Loopback and metadata remain blocked regardless.
    await expect(assertUrlAllowed("http://127.0.0.1")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertUrlAllowed("http://169.254.169.254")).rejects.toBeInstanceOf(SsrfError);
  });

  it("allows a public IP literal", async () => {
    const url = await assertUrlAllowed("http://8.8.8.8/");
    expect(url.hostname).toBe("8.8.8.8");
  });

  it("rejects invalid URLs", async () => {
    await expect(assertUrlAllowed("not a url")).rejects.toBeInstanceOf(SsrfError);
  });
});
