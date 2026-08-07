/**
 * "Find this title on that service" links.
 *
 * The dashboard prefers a real deep link to the title (Watchmode's `web_url`),
 * but there isn't always one: Watchmode returns per-episode links on paid plans
 * only, its show-level sources sometimes omit a service we matched on, and TMDB
 * gives movie availability with no per-provider link at all. Those logos used to
 * render unlinked, which is a dead end for the one thing you want to do with a
 * provider logo — open the title on that service.
 *
 * So when there's no deep link, fall back to the service's own search page for
 * the title. It is one click further away than a deep link, but it lands on the
 * right service and finds the title there, which beats both a dead logo and a
 * link that leaves the service entirely.
 *
 * Only services whose search URL is known are listed here; anything else falls
 * back to the caller's own fallback (the TMDB "where to watch" page), so an
 * unknown service never produces an invented link.
 */

/**
 * Names arrive from two catalogues (Watchmode sources, TMDB providers) that
 * punctuate differently — "Disney+", "Disney Plus", "disney+ " — and Watchmode
 * also sells reseller variants like "Paramount+ Amazon Channel". Fold all of
 * that down to bare lowercase letters and digits, with "+" spelled out, so one
 * pattern per service is enough.
 */
export function normalizeServiceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\+/g, "plus")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

/** Amazon's storefronts are per-country, so search on the viewer's own one. */
const AMAZON_TLD: Record<string, string> = {
  AU: "com.au",
  BR: "com.br",
  CA: "ca",
  DE: "de",
  ES: "es",
  FR: "fr",
  GB: "co.uk",
  UK: "co.uk",
  IN: "in",
  IT: "it",
  JP: "co.jp",
  MX: "com.mx",
  NL: "nl",
  PL: "pl",
  SE: "se",
  SG: "sg",
  TR: "com.tr",
  US: "com",
};

const amazonHost = (region: string) => `www.amazon.${AMAZON_TLD[region.toUpperCase()] ?? "com"}`;

interface ProviderSite {
  /** Tested against the normalized service name. */
  match: RegExp;
  /** `query` is already URL-encoded; `region` is the ISO country we matched in. */
  url: (query: string, region: string) => string;
}

/**
 * Ordered: the first pattern that matches wins, so narrower services (Cinemax,
 * Amazon-resold channels) must come before the broader ones they'd match.
 */
const SITES: ProviderSite[] = [
  { match: /netflix/, url: (q) => `https://www.netflix.com/search?q=${q}` },
  {
    match: /primevideo|amazonvideo|amazoninstantvideo/,
    url: (q, r) => `https://${amazonHost(r)}/s?k=${q}&i=instant-video`,
  },
  { match: /disneyplus/, url: (q) => `https://www.disneyplus.com/search?q=${q}` },
  { match: /appletv|itunes/, url: (q) => `https://tv.apple.com/search?term=${q}` },
  // "cinemax" contains "max": claim it first so it can't fall into the Max rule.
  { match: /cinemax/, url: (q) => `https://www.cinemax.com/search?q=${q}` },
  { match: /hbomax|hbonow|^hbo$|^max/, url: (q) => `https://www.max.com/search?q=${q}` },
  { match: /hulu/, url: (q) => `https://www.hulu.com/search?q=${q}` },
  { match: /paramountplus/, url: (q) => `https://www.paramountplus.com/search/?q=${q}` },
  { match: /peacock/, url: (q) => `https://www.peacocktv.com/search?q=${q}` },
  { match: /britbox/, url: (q) => `https://www.britbox.com/search?q=${q}` },
  { match: /crunchyroll/, url: (q) => `https://www.crunchyroll.com/search?q=${q}` },
  { match: /discoveryplus/, url: (q) => `https://www.discoveryplus.com/search?q=${q}` },
  { match: /amcplus/, url: (q) => `https://www.amcplus.com/search?q=${q}` },
  { match: /shudder/, url: (q) => `https://www.shudder.com/search?q=${q}` },
  { match: /mubi/, url: (q) => `https://mubi.com/en/search?query=${q}` },
  { match: /tubi/, url: (q) => `https://tubitv.com/search/${q}` },
  { match: /plutotv/, url: (q) => `https://pluto.tv/en/search?q=${q}` },
  { match: /rokuchannel/, url: (q) => `https://therokuchannel.roku.com/search/${q}` },
  { match: /plex/, url: (q) => `https://watch.plex.tv/search?q=${q}` },
  { match: /googleplay/, url: (q) => `https://play.google.com/store/search?q=${q}&c=movies` },
  { match: /youtube/, url: (q) => `https://www.youtube.com/results?search_query=${q}` },
  // Australian services.
  { match: /^stan/, url: (q) => `https://www.stan.com.au/search?q=${q}` },
  { match: /binge/, url: (q) => `https://binge.com.au/search?q=${q}` },
  { match: /abciview|abcivew|^iview/, url: (q) => `https://iview.abc.net.au/search?q=${q}` },
  { match: /sbsondemand/, url: (q) => `https://www.sbs.com.au/ondemand/search/${q}` },
  { match: /^7plus|channel7|seven/, url: (q) => `https://7plus.com.au/search?q=${q}` },
  { match: /^9now|channel9|^nine/, url: (q) => `https://www.9now.com.au/search?q=${q}` },
  { match: /^10play|^tenplay|channel10/, url: (q) => `https://10play.com.au/search?q=${q}` },
];

/**
 * The service's own search page for `title`, or null for a service we don't
 * know the search URL of (the caller then uses its own fallback).
 */
export function providerSearchUrl(
  serviceName: string,
  title: string,
  region: string | null | undefined = null
): string | null {
  if (typeof serviceName !== "string" || typeof title !== "string") return null;
  const name = normalizeServiceName(serviceName);
  const trimmedTitle = title.trim();
  if (!name || !trimmedTitle) return null;
  const site = SITES.find((s) => s.match.test(name));
  if (!site) return null;
  return site.url(encodeURIComponent(trimmedTitle), region ?? "");
}
