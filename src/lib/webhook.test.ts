import { describe, it, expect } from "vitest";
import {
  connectionTypeFor,
  generateWebhookToken,
  isArrKind,
  mediaTypeFor,
  parseArrWebhook,
  resolveWebhookConnection,
  tokenMatches,
  webhookTokenFromRequest,
  webhookUrl,
} from "./webhook";

/**
 * The webhook endpoint is the one route that answers without a session, so
 * these tests are the guard rails on what it will act on: which payloads count
 * as "a title was added", which credential slots are honoured, and when an
 * ambiguous instance is refused rather than guessed at.
 */

const req = (url: string, headers: Record<string, string> = {}) => ({
  url,
  headers: new Headers(headers),
});

const BASE = "https://sweep.example.com/api/webhook/sonarr";

describe("isArrKind", () => {
  it("accepts the two *arr kinds and nothing else", () => {
    expect(isArrKind("sonarr")).toBe(true);
    expect(isArrKind("radarr")).toBe(true);
    expect(isArrKind("lidarr")).toBe(false);
    expect(isArrKind("")).toBe(false);
  });

  it("maps a kind to its connection and media type", () => {
    expect(connectionTypeFor("sonarr")).toBe("SONARR");
    expect(mediaTypeFor("sonarr")).toBe("TV");
    expect(connectionTypeFor("radarr")).toBe("RADARR");
    expect(mediaTypeFor("radarr")).toBe("MOVIE");
  });
});

describe("tokens", () => {
  it("mints URL-safe tokens that differ every time", () => {
    const a = generateWebhookToken();
    const b = generateWebhookToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("matches only an identical token", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    // Different lengths must be a plain mismatch, not a thrown comparison.
    expect(tokenMatches("abc", "abcdef")).toBe(false);
  });

  it("treats a missing token on either side as a mismatch", () => {
    expect(tokenMatches(null, "abc")).toBe(false);
    expect(tokenMatches("abc", null)).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });
});

describe("webhookTokenFromRequest", () => {
  it("reads the query string first", () => {
    expect(webhookTokenFromRequest(req(`${BASE}?token=t1`))).toBe("t1");
    expect(webhookTokenFromRequest(req(`${BASE}?apikey=t2`))).toBe("t2");
  });

  it("reads the custom header", () => {
    expect(webhookTokenFromRequest(req(BASE, { "X-Webhook-Token": " t3 " }))).toBe("t3");
  });

  it("reads a bearer token", () => {
    expect(webhookTokenFromRequest(req(BASE, { Authorization: "Bearer t4" }))).toBe("t4");
  });

  it("reads the password out of basic auth, ignoring the username", () => {
    const basic = Buffer.from("streamsweeparr:t5").toString("base64");
    expect(webhookTokenFromRequest(req(BASE, { Authorization: `Basic ${basic}` }))).toBe("t5");
  });

  it("returns null when no credential is present", () => {
    expect(webhookTokenFromRequest(req(BASE))).toBeNull();
    expect(webhookTokenFromRequest(req(BASE, { Authorization: "Digest nope" }))).toBeNull();
  });
});

describe("parseArrWebhook", () => {
  it("reads a Sonarr series add", () => {
    const parsed = parseArrWebhook("sonarr", {
      eventType: "SeriesAdd",
      instanceName: "Sonarr",
      series: { id: 42, title: "Severance", tvdbId: 371980 },
    });
    expect(parsed).toEqual({
      kind: "added",
      eventType: "SeriesAdd",
      arrId: 42,
      title: "Severance",
      instanceName: "Sonarr",
    });
  });

  it("reads a Radarr movie add", () => {
    const parsed = parseArrWebhook("radarr", {
      eventType: "MovieAdded",
      movie: { id: 7, title: "Arrival", year: 2016 },
    });
    expect(parsed.kind).toBe("added");
    expect(parsed.arrId).toBe(7);
    expect(parsed.title).toBe("Arrival");
  });

  it("does not care how the *arr spelled the tense, or the case", () => {
    expect(parseArrWebhook("sonarr", { eventType: "seriesadded", series: { id: 1 } }).kind).toBe(
      "added"
    );
    expect(parseArrWebhook("radarr", { eventType: "MovieAdd", movie: { id: 1 } }).kind).toBe(
      "added"
    );
  });

  it("does not read one *arr's payload as the other's", () => {
    // A Radarr URL wired into Sonarr by mistake must do nothing, not sweep
    // whatever movie happens to share the series' id.
    expect(parseArrWebhook("radarr", { eventType: "SeriesAdd", series: { id: 9 } }).kind).toBe(
      "ignored"
    );
  });

  it("treats a Test payload as a test, despite its fake title block", () => {
    const parsed = parseArrWebhook("sonarr", {
      eventType: "Test",
      series: { id: 1, title: "Test Title" },
    });
    expect(parsed.kind).toBe("test");
    expect(parsed.arrId).toBeUndefined();
  });

  it("ignores every other trigger", () => {
    for (const eventType of ["Download", "Grab", "Health", "Rename", "SeriesDelete"]) {
      expect(parseArrWebhook("sonarr", { eventType, series: { id: 3 } }).kind).toBe("ignored");
    }
  });

  it("ignores an add with no usable id", () => {
    expect(parseArrWebhook("sonarr", { eventType: "SeriesAdd" }).kind).toBe("ignored");
    expect(parseArrWebhook("sonarr", { eventType: "SeriesAdd", series: {} }).kind).toBe("ignored");
    expect(
      parseArrWebhook("sonarr", { eventType: "SeriesAdd", series: { id: "12" } }).kind
    ).toBe("ignored");
  });

  it("falls back to the id when the payload carries no title", () => {
    expect(parseArrWebhook("sonarr", { eventType: "SeriesAdd", series: { id: 12 } }).title).toBe(
      "#12"
    );
  });

  it("survives a body that is not an object", () => {
    expect(parseArrWebhook("sonarr", null).kind).toBe("ignored");
    expect(parseArrWebhook("sonarr", "hello").kind).toBe("ignored");
  });
});

describe("resolveWebhookConnection", () => {
  const connections = [
    { id: 1, type: "SONARR", name: "Sonarr", enabled: true },
    { id: 2, type: "SONARR", name: "Sonarr 4K", enabled: true },
    { id: 3, type: "RADARR", name: "Radarr", enabled: true },
    { id: 4, type: "SONARR", name: "Old Sonarr", enabled: false },
  ];

  it("uses the id from the URL when there is one", () => {
    const match = resolveWebhookConnection("sonarr", connections, { connectionId: 2 });
    expect(match).toEqual({ ok: true, connection: connections[1] });
  });

  it("refuses an id that names a disabled or wrong-type connection", () => {
    expect(resolveWebhookConnection("sonarr", connections, { connectionId: 4 }).ok).toBe(false);
    expect(resolveWebhookConnection("sonarr", connections, { connectionId: 3 }).ok).toBe(false);
  });

  it("picks the only candidate when there is exactly one", () => {
    const match = resolveWebhookConnection("radarr", connections);
    expect(match).toEqual({ ok: true, connection: connections[2] });
  });

  it("falls back to the instance name when several could match", () => {
    const match = resolveWebhookConnection("sonarr", connections, { instanceName: "sonarr 4k" });
    expect(match).toEqual({ ok: true, connection: connections[1] });
  });

  it("refuses to guess between instances rather than sweep the wrong library", () => {
    const match = resolveWebhookConnection("sonarr", connections, { instanceName: "Unknown" });
    expect(match.ok).toBe(false);
    if (!match.ok) {
      expect(match.status).toBe(409);
      expect(match.error).toContain("connection=");
    }
  });

  it("reports when nothing of that kind is configured", () => {
    const match = resolveWebhookConnection("radarr", [connections[0]]);
    expect(match.ok).toBe(false);
    if (!match.ok) expect(match.status).toBe(404);
  });
});

describe("webhookUrl", () => {
  it("builds the URL a user pastes into an *arr", () => {
    expect(webhookUrl("https://sweep.example.com", "sonarr", { token: "abc", connectionId: 2 })).toBe(
      "https://sweep.example.com/api/webhook/sonarr?token=abc&connection=2"
    );
  });

  it("tolerates a trailing slash and a path-less origin", () => {
    expect(webhookUrl("http://localhost:3000/", "radarr", { token: "t" })).toBe(
      "http://localhost:3000/api/webhook/radarr?token=t"
    );
  });

  it("omits parts it was not given", () => {
    expect(webhookUrl("http://localhost:3000", "sonarr")).toBe(
      "http://localhost:3000/api/webhook/sonarr"
    );
  });
});
