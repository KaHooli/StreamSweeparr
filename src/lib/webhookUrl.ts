/**
 * Webhook addressing — the half of the webhook feature the browser needs too.
 *
 * The Settings card has to render the exact URL the user pastes into Sonarr or
 * Radarr, so the kinds and the URL shape live here, free of any Node-only
 * import. `lib/webhook.ts` holds the rest — payload parsing and the shared
 * secret — and is server-only because it reaches for node:crypto.
 */

/** Which *arr a webhook came from. Also the last path segment of the endpoint. */
export type ArrKind = "sonarr" | "radarr";

export const ARR_KINDS: ArrKind[] = ["sonarr", "radarr"];

/** Whether a path segment names an *arr we accept webhooks from. */
export function isArrKind(value: string): value is ArrKind {
  return (ARR_KINDS as string[]).includes(value);
}

/** The connection type an *arr kind maps to. */
export function connectionTypeFor(kind: ArrKind): "SONARR" | "RADARR" {
  return kind === "sonarr" ? "SONARR" : "RADARR";
}

/** The media a connection of this kind holds. */
export function mediaTypeFor(kind: ArrKind): "TV" | "MOVIE" {
  return kind === "sonarr" ? "TV" : "MOVIE";
}

/**
 * The URL to paste into a Sonarr/Radarr webhook connection.
 *
 * The token rides in the query string because that is the one credential slot
 * every version of both apps supports (see `webhookTokenFromRequest`), and
 * `connection` names the instance so several of them can share one token.
 */
export function webhookUrl(
  origin: string,
  kind: ArrKind,
  opts: { token?: string | null; connectionId?: number | null } = {}
): string {
  const url = new URL(`/api/webhook/${kind}`, origin.replace(/\/+$/, "") + "/");
  if (opts.token) url.searchParams.set("token", opts.token);
  if (opts.connectionId != null) url.searchParams.set("connection", String(opts.connectionId));
  return url.toString();
}
