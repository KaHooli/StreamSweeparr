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

/**
 * Reduce a `?next=` destination to something that can only be a page of this
 * app. Anything else becomes the dashboard.
 *
 * The login page is reachable without a session and navigates to whatever
 * `next` says the moment one exists. Handed an absolute URL it navigates
 * *there* — so `…/login?next=https://evil.example` turns this app's own login
 * screen into a redirector, which is the shape a credential-phishing page wants
 * to borrow: the victim follows a link to a host they recognise, signs in, and
 * lands somewhere else with the trust of the first hop intact.
 *
 * The proxy only ever builds this parameter from a request path, so nothing
 * legitimate is lost by insisting on one. Two cases are worth spelling out:
 *
 *  - `//evil.example` looks like a path and is not one — it is scheme-relative
 *    and names another origin. `/\evil.example` is the same thing, because
 *    browsers read a backslash here as a slash.
 *  - `javascript:` and friends are excluded by the same rule, since a scheme
 *    cannot appear before the leading slash.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (typeof value !== "string") return "/";
  const next = value.trim();
  if (!next.startsWith("/")) return "/";
  if (/^\/[/\\]/.test(next)) return "/";
  // Control characters are stripped rather than rendered by browsers, so a
  // destination containing them is not the destination it appears to be.
  if (/[\u0000-\u001f\u007f]/.test(next)) return "/";
  return next;
}

/** TMDB "where to watch" page for a title, or null without an id. */
export function tmdbWatchUrl(type: "movie" | "tv", tmdbId: number | null | undefined): string | null {
  if (!tmdbId) return null;
  return `https://www.themoviedb.org/${type}/${tmdbId}/watch`;
}
