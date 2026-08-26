import { describe, it, expect } from "vitest";
import { safeNextPath, sanitizeExternalUrl, tmdbWatchUrl } from "./urls";

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

describe("safeNextPath", () => {
  it("keeps the paths the proxy actually builds", () => {
    expect(safeNextPath("/settings")).toBe("/settings");
    expect(safeNextPath("/runs?status=FAILED")).toBe("/runs?status=FAILED");
    expect(safeNextPath("/")).toBe("/");
  });

  it("refuses an absolute URL pointing at another site", () => {
    // The open-redirect case: a link to this app's own login page that lands
    // the victim on somebody else's, having signed in on the way past.
    expect(safeNextPath("https://evil.example/login")).toBe("/");
    expect(safeNextPath("http://evil.example")).toBe("/");
  });

  it("refuses the spellings that look like a path and are not", () => {
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("  //evil.example")).toBe("/");
  });

  it("refuses other schemes", () => {
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
    expect(safeNextPath("data:text/html,<script>alert(1)</script>")).toBe("/");
  });

  it("refuses control characters, which browsers strip before navigating", () => {
    expect(safeNextPath("/\t//evil.example")).toBe("/");
    expect(safeNextPath("/\n/evil.example")).toBe("/");
  });

  it("falls back to the dashboard when there is nothing usable", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("settings")).toBe("/");
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
