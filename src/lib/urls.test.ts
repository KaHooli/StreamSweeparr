import { describe, it, expect } from "vitest";
import { sanitizeExternalUrl, tmdbWatchUrl } from "./urls";

describe("sanitizeExternalUrl", () => {
  it("keeps absolute http(s) URLs", () => {
    expect(sanitizeExternalUrl("https://www.netflix.com/title/80192098")).toBe(
      "https://www.netflix.com/title/80192098"
    );
    expect(sanitizeExternalUrl("http://example.com/a?b=1")).toBe("http://example.com/a?b=1");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeExternalUrl("  https://example.com/x  ")).toBe("https://example.com/x");
  });

  it("rejects Watchmode's free-plan placeholder sentence", () => {
    // This is the real value Watchmode returns for web_url on free plans; used
    // as an href it would resolve relative to our own domain.
    expect(sanitizeExternalUrl("Episode links available for paid plans only.")).toBeNull();
  });

  it("rejects relative paths and other non-absolute values", () => {
    expect(sanitizeExternalUrl("/watch/123")).toBeNull();
    expect(sanitizeExternalUrl("watch/123")).toBeNull();
    expect(sanitizeExternalUrl("www.example.com")).toBeNull();
  });

  it("rejects non-http schemes", () => {
    expect(sanitizeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeExternalUrl("file:///etc/passwd")).toBeNull();
    expect(sanitizeExternalUrl("ftp://example.com")).toBeNull();
  });

  it("rejects empty and non-string values", () => {
    expect(sanitizeExternalUrl("")).toBeNull();
    expect(sanitizeExternalUrl("   ")).toBeNull();
    expect(sanitizeExternalUrl(null)).toBeNull();
    expect(sanitizeExternalUrl(undefined)).toBeNull();
    expect(sanitizeExternalUrl(42)).toBeNull();
  });
});

describe("tmdbWatchUrl", () => {
  it("builds movie and tv watch URLs", () => {
    expect(tmdbWatchUrl("movie", 687163)).toBe("https://www.themoviedb.org/movie/687163/watch");
    expect(tmdbWatchUrl("tv", 1396)).toBe("https://www.themoviedb.org/tv/1396/watch");
  });

  it("returns null without an id", () => {
    expect(tmdbWatchUrl("tv", null)).toBeNull();
    expect(tmdbWatchUrl("movie", undefined)).toBeNull();
    expect(tmdbWatchUrl("movie", 0)).toBeNull();
  });
});
