/**
 * Feed addressing — the half of the streaming-link feed the browser needs too.
 *
 * The Settings card renders the exact URLs an admin pastes into another app,
 * so the kinds and paths live here, free of any Node-only import. `lib/feed.ts`
 * holds the rest (the query, the shape, the key extraction) and is server-only.
 *
 * `src/proxy.ts` imports `FEED_PATHS` to let exactly these paths past the
 * session gate. The proxy runs on the edge runtime, so this file must stay
 * free of imports — a Node built-in reached from here would break every page.
 */

/** Which feed. Also the last path segment of the endpoint. */
export type FeedKind = "tv" | "movies";

export const FEED_KINDS: FeedKind[] = ["tv", "movies"];

/** Whether a path segment names a feed. */
export function isFeedKind(value: string): value is FeedKind {
  return (FEED_KINDS as string[]).includes(value);
}

export const FEED_PATHS: Record<FeedKind, string> = {
  tv: "/api/feed/tv",
  movies: "/api/feed/movies",
};

/**
 * The URL to give another app.
 *
 * The key is deliberately *not* put in the query string, unlike the webhook
 * URL: a feed consumer is a program the admin configures with a separate key
 * field, and a key in a URL ends up in reverse-proxy access logs. `?apikey=`
 * still works for consumers that can only take a URL.
 */
export function feedUrl(origin: string, kind: FeedKind): string {
  return new URL(FEED_PATHS[kind], origin.replace(/\/+$/, "") + "/").toString();
}
