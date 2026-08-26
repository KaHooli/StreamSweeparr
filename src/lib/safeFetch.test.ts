import { describe, it, expect, beforeEach, vi } from "vitest";
import { assertUrlAllowed, SsrfError } from "./safeFetch";

/**
 * The resolver, so a hostname can be pointed at a chosen address. This is the
 * path that matters most: a literal is typed by the administrator, whereas the
 * address behind a hostname is chosen by whoever controls its DNS.
 */
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

/** Point every hostname at `address` for the duration of one test. */
function resolvesTo(address: string, family: 4 | 6) {
  lookupMock.mockResolvedValue([{ address, family }]);
}

describe("SSRF guard (assertUrlAllowed)", () => {
  beforeEach(() => {
    delete process.env.SSRF_ALLOW_PRIVATE;
    lookupMock.mockReset();
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
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

  /**
   * An IPv6 address has many spellings and they all reach the same host, so the
   * guard has to classify what an address *is* rather than how it was typed.
   * Each of these is loopback or the metadata service under another name; a
   * rule written against the text of `::ffff:127.0.0.1` recognises none of them.
   */
  it("blocks loopback and metadata however the IPv6 literal is spelled", async () => {
    const aliases = [
      "http://[::1]/",
      "http://[0:0:0:0:0:0:0:1]/",
      "http://[::ffff:127.0.0.1]/", // IPv4-mapped, dotted
      "http://[::ffff:7f00:1]/", // the same address, in hex
      "http://[0:0:0:0:0:ffff:7f00:0001]/", // and again, uncompressed
      "http://[::127.0.0.1]/", // IPv4-compatible
      "http://[::ffff:a9fe:a9fe]/", // 169.254.169.254 mapped
      "http://[64:ff9b::a9fe:a9fe]/", // ...via the NAT64 prefix
      "http://[2002:a9fe:a9fe::]/", // ...and via 6to4
      "http://[feb0::1]/", // fe80::/10 is wider than the "fe80" prefix
      "http://[ff02::1]/", // multicast
    ];
    for (const url of aliases) {
      await expect(assertUrlAllowed(url), url).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it("blocks IPv6 private ranges by default, however spelled", async () => {
    await expect(assertUrlAllowed("http://[fd00::1]/")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertUrlAllowed("http://[fc00::1]/")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertUrlAllowed("http://[::ffff:c0a8:10a]:7878/")).rejects.toBeInstanceOf(
      SsrfError
    );
  });

  it("allows a public IPv6 literal", async () => {
    // The brackets are part of the URL's hostname, not of the address. Left in
    // place they made every IPv6 literal — this one included — unresolvable.
    const url = await assertUrlAllowed("http://[2001:4860:4860::8888]/");
    expect(url.hostname).toBe("[2001:4860:4860::8888]");
  });

  it("allows an opted-in private IPv6 host but never loopback", async () => {
    process.env.SSRF_ALLOW_PRIVATE = "true";
    const url = await assertUrlAllowed("http://[fd12:3456::1]:8989/");
    expect(url.hostname).toBe("[fd12:3456::1]");
    await expect(assertUrlAllowed("http://[::ffff:7f00:1]/")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertUrlAllowed("http://[::ffff:a9fe:a9fe]/")).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects invalid URLs", async () => {
    await expect(assertUrlAllowed("not a url")).rejects.toBeInstanceOf(SsrfError);
  });

  /**
   * The literals above are typed by an administrator; these are not. A hostname
   * resolves to whatever its owner's DNS says, so an AAAA record is the way an
   * outsider gets to choose the address this app connects to — which makes it
   * the spelling the guard has to get right.
   */
  describe("addresses arriving from DNS", () => {
    it("blocks a hostname whose AAAA record is loopback in any form", async () => {
      for (const address of ["::1", "::ffff:127.0.0.1", "::127.0.0.1", "::ffff:7f00:1"]) {
        resolvesTo(address, 6);
        await expect(assertUrlAllowed("http://sonarr.example.com/"), address).rejects.toBeInstanceOf(
          SsrfError
        );
      }
    });

    it("blocks a hostname pointed at the cloud metadata service over IPv6", async () => {
      for (const address of ["::ffff:169.254.169.254", "::169.254.169.254", "64:ff9b::a9fe:a9fe"]) {
        resolvesTo(address, 6);
        await expect(assertUrlAllowed("http://metadata.example.com/"), address).rejects.toBeInstanceOf(
          SsrfError
        );
      }
    });

    it("blocks a hostname pointed anywhere in fe80::/10, not just at fe80::", async () => {
      resolvesTo("feb0::1", 6);
      await expect(assertUrlAllowed("http://link.example.com/")).rejects.toBeInstanceOf(SsrfError);
    });

    it("still allows a hostname on a public IPv6 address", async () => {
      resolvesTo("2606:4700:4700::1111", 6);
      const url = await assertUrlAllowed("http://dns.example.com/");
      expect(url.hostname).toBe("dns.example.com");
    });

    it("blocks a private AAAA record unless SSRF_ALLOW_PRIVATE is set", async () => {
      resolvesTo("fd00::5", 6);
      await expect(assertUrlAllowed("http://nas.example.com:8989/")).rejects.toBeInstanceOf(SsrfError);
      process.env.SSRF_ALLOW_PRIVATE = "true";
      const url = await assertUrlAllowed("http://nas.example.com:8989/");
      expect(url.hostname).toBe("nas.example.com");
    });

    it("checks every record, not just the first", async () => {
      lookupMock.mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "::ffff:7f00:1", family: 6 },
      ]);
      await expect(assertUrlAllowed("http://rebind.example.com/")).rejects.toBeInstanceOf(SsrfError);
    });
  });
});
