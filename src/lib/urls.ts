/**
 * Helpers for links we hand to the browser.
 *
 * Third-party APIs don't always return what their schema promises. Watchmode,
 * for example, puts the sentence "Episode links available for paid plans only."
 * in a source's `web_url` on the free plan. Rendering that as an href makes the
 * browser treat it as a *relative* path, producing links like
 * `https://your-host/Episode%20links%20available%20for%20paid%20plans%20only.`
 * so every external URL is validated before use.
 */

/** Return `value` only if it is a usable absolute http(s) URL, else null. */
export function sanitizeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Not absolute (relative paths, sentences, placeholders…).
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString();
}

/** TMDB "where to watch" page for a title, or null without an id. */
export function tmdbWatchUrl(type: "movie" | "tv", tmdbId: number | null | undefined): string | null {
  if (!tmdbId) return null;
  return `https://www.themoviedb.org/${type}/${tmdbId}/watch`;
}
