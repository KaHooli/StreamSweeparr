import { describe, it, expect } from "vitest";
import { normalizeServiceName, providerSearchUrl } from "./providerSites";

describe("normalizeServiceName", () => {
  it("folds punctuation and case away, spelling out '+'", () => {
    expect(normalizeServiceName("Disney+")).toBe("disneyplus");
    expect(normalizeServiceName("Apple TV+")).toBe("appletvplus");
    expect(normalizeServiceName("  BINGE ")).toBe("binge");
    expect(normalizeServiceName("SBS On Demand")).toBe("sbsondemand");
  });
});

describe("providerSearchUrl", () => {
  it("builds a search URL on the service's own site", () => {
    expect(providerSearchUrl("Netflix", "A Christmas Carol")).toBe(
      "https://www.netflix.com/search?q=A%20Christmas%20Carol"
    );
    expect(providerSearchUrl("Disney+", "Andor")).toBe(
      "https://www.disneyplus.com/search?q=Andor"
    );
    expect(providerSearchUrl("Stan", "Bluey")).toBe("https://www.stan.com.au/search?q=Bluey");
  });

  it("matches reseller and punctuation variants of the same service", () => {
    // Watchmode sells "X Amazon Channel" variants; TMDB spells "+" as "Plus".
    expect(providerSearchUrl("Paramount Plus Amazon Channel", "Yellowstone")).toBe(
      "https://www.paramountplus.com/search/?q=Yellowstone"
    );
    expect(providerSearchUrl("Amazon Prime Video", "Fallout", "US")).toBe(
      "https://www.amazon.com/s?k=Fallout&i=instant-video"
    );
  });

  it("sends Amazon searches to the storefront for the matched region", () => {
    expect(providerSearchUrl("Prime Video", "Fallout", "AU")).toBe(
      "https://www.amazon.com.au/s?k=Fallout&i=instant-video"
    );
    expect(providerSearchUrl("Prime Video", "Fallout", "gb")).toBe(
      "https://www.amazon.co.uk/s?k=Fallout&i=instant-video"
    );
    // Unknown/missing region falls back to the .com storefront.
    expect(providerSearchUrl("Prime Video", "Fallout", "ZZ")).toBe(
      "https://www.amazon.com/s?k=Fallout&i=instant-video"
    );
    expect(providerSearchUrl("Prime Video", "Fallout")).toBe(
      "https://www.amazon.com/s?k=Fallout&i=instant-video"
    );
  });

  it("does not let Cinemax fall into the Max rule", () => {
    expect(providerSearchUrl("Cinemax", "Warrior")).toContain("cinemax.com");
    expect(providerSearchUrl("Max", "Warrior")).toBe("https://www.max.com/search?q=Warrior");
    expect(providerSearchUrl("HBO Max", "Warrior")).toBe("https://www.max.com/search?q=Warrior");
  });

  it("escapes the title so punctuation can't break out of the query", () => {
    const url = providerSearchUrl("Netflix", "Marvel's Daredevil & Co?");
    expect(url).toBe("https://www.netflix.com/search?q=Marvel's%20Daredevil%20%26%20Co%3F");
    expect(new URL(url!).searchParams.get("q")).toBe("Marvel's Daredevil & Co?");
  });

  it("returns null for services we have no known search URL for", () => {
    expect(providerSearchUrl("Some Regional Broadcaster", "A Christmas Carol")).toBeNull();
  });

  it("returns null on missing inputs rather than linking to a bare search page", () => {
    expect(providerSearchUrl("Netflix", "")).toBeNull();
    expect(providerSearchUrl("Netflix", "   ")).toBeNull();
    expect(providerSearchUrl("", "Andor")).toBeNull();
  });

  it("only ever produces absolute https URLs", () => {
    const names = [
      "Netflix",
      "Prime Video",
      "Disney+",
      "Apple TV+",
      "Max",
      "Hulu",
      "Paramount+",
      "Peacock",
      "BritBox",
      "Crunchyroll",
      "discovery+",
      "AMC+",
      "Shudder",
      "MUBI",
      "Tubi TV",
      "Pluto TV",
      "The Roku Channel",
      "Plex",
      "Google Play Movies",
      "YouTube",
      "Stan",
      "BINGE",
      "ABC iview",
      "SBS On Demand",
      "7plus",
      "9Now",
      "10 play",
    ];
    for (const name of names) {
      const url = providerSearchUrl(name, "A Christmas Carol", "AU");
      expect(url, name).toBeTruthy();
      expect(new URL(url!).protocol, name).toBe("https:");
    }
  });
});
