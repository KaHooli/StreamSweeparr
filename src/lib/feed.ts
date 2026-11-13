/**
 * The streaming-link feed: where each title in the library can be watched.
 *
 * `GET /api/feed/tv` and `GET /api/feed/movies` hand another self-hosted
 * program — a portal like Hearthport, a home dashboard — one entry per title on
 * the user's services, each with one link per service. That program knows
 * nothing about Watchmode or TMDB; it matches entries to its own titles by
 * `tmdbId` (or `tvdbId` / `imdbId`) and shows the links.
 *
 * What bounds the cost of serving it:
 *
 *  - **No provider calls.** Everything comes from the snapshot sync already
 *    wrote, so a consumer polling every minute costs one indexed query, never
 *    a Watchmode credit. The links are exactly as fresh as the last sync.
 *  - **The dashboard's set, not the library.** Only `onStreaming` titles are
 *    listed — what the admin asked for — so the response is as large as the
 *    dashboard, and uses the same `(type, onStreaming)` index.
 *
 * Skipped titles (`ss-skip`) are left out. They are never looked up, so any
 * `streamingInfo` they carry is whatever was there when the tag was added —
 * an answer nobody is keeping current.
 *
 * Node-runtime only (reads the database). The URL half the Settings card needs
 * lives in `lib/feedUrl.ts`.
 */

import { prisma } from "./db";
import { dedupeServices, type DashboardService, type ServiceLinkKind } from "./dashboard";
import { tmdbWatchUrl } from "./urls";
import type { FeedKind } from "./feedUrl";

/**
 * One service a title is on, with the best link we have to it there. The same
 * shape the dashboard renders, so a link means the same thing in both places.
 */
export type FeedService = DashboardService;

export interface FeedItem {
  title: string;
  year: number | null;
  tmdbId: number | null;
  /** TV only. */
  tvdbId?: number | null;
  imdbId: string | null;
  posterUrl: string | null;
  /** TV only: how many of the show's episodes are on the user's services. */
  episodes?: { streaming: number; total: number };
  /**
   * When the provider was last asked about this title (null if it never was —
   * e.g. a row whose answer came from before the column existed). The links are
   * no fresher than this.
   */
  checkedAt: string | null;
  services: FeedService[];
}

export interface Feed {
  type: FeedKind;
  generatedAt: string;
  count: number;
  items: FeedItem[];
}

/** The columns a feed row needs — and, deliberately, nothing else. */
export interface FeedRow {
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  posterUrl: string | null;
  totalEpisodes: number;
  streamingEpisodes: number;
  providerSyncedAt: Date | null;
  streamingInfo: unknown;
}

/** Best first; a lower index wins when two rows disagree about one service. */
const LINK_RANK: (ServiceLinkKind | null)[] = ["direct", "search", "tmdb", null];

function betterLink(a: FeedService, b: FeedService): FeedService {
  return LINK_RANK.indexOf(b.linkKind) < LINK_RANK.indexOf(a.linkKind) ? b : a;
}

function laterDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function toItem(row: FeedRow, kind: FeedKind): FeedItem {
  const services = dedupeServices(
    row.streamingInfo,
    tmdbWatchUrl(kind === "tv" ? "tv" : "movie", row.tmdbId),
    row.title
  );
  return {
    title: row.title,
    year: row.year,
    tmdbId: row.tmdbId,
    ...(kind === "tv" ? { tvdbId: row.tvdbId } : {}),
    imdbId: row.imdbId,
    posterUrl: row.posterUrl,
    ...(kind === "tv"
      ? { episodes: { streaming: row.streamingEpisodes, total: row.totalEpisodes } }
      : {}),
    checkedAt: row.providerSyncedAt ? row.providerSyncedAt.toISOString() : null,
    services,
  };
}

/** Fold `b` (another instance's copy of the same title) into `a`. */
function mergeInto(a: FeedItem, b: FeedItem): void {
  const byName = new Map(a.services.map((s) => [s.name, s]));
  for (const s of b.services) {
    const existing = byName.get(s.name);
    byName.set(s.name, existing ? betterLink(existing, s) : s);
  }
  a.services = [...byName.values()].sort((x, y) => x.name.localeCompare(y.name));
  a.year ??= b.year;
  a.tvdbId ??= b.tvdbId;
  a.imdbId ??= b.imdbId;
  a.posterUrl ??= b.posterUrl;
  if (a.episodes && b.episodes) {
    a.episodes = {
      streaming: Math.max(a.episodes.streaming, b.episodes.streaming),
      total: Math.max(a.episodes.total, b.episodes.total),
    };
  }
  a.checkedAt = laterDate(a.checkedAt, b.checkedAt);
}

/**
 * Rows → feed entries, one per title.
 *
 * `MediaItem` is per *connection*, so a title held by two Sonarr instances (a
 * 4K one alongside the main one, say) is two rows. A consumer matching on
 * `tmdbId` would otherwise see the same show twice and have to guess which
 * entry to believe, so rows sharing a `tmdbId` are merged: services unioned by
 * name, keeping the best link for each, episode counts maxed, the latest check
 * time kept. Rows with no `tmdbId` have nothing trustworthy to merge on — two
 * different films can share a title and year — so they stay separate.
 *
 * Pure: the unit tests pin this.
 */
export function buildFeedItems(rows: FeedRow[], kind: FeedKind): FeedItem[] {
  const out: FeedItem[] = [];
  const byTmdb = new Map<number, FeedItem>();
  for (const row of rows) {
    const item = toItem(row, kind);
    if (row.tmdbId == null) {
      out.push(item);
      continue;
    }
    const existing = byTmdb.get(row.tmdbId);
    if (existing) {
      mergeInto(existing, item);
    } else {
      byTmdb.set(row.tmdbId, item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Parse `?tmdbId=` — repeatable, and each value may be comma-separated, so
 * `?tmdbId=1&tmdbId=2` and `?tmdbId=1,2` mean the same. Returns null when the
 * parameter is absent (no filter), or `{ error }` for anything that is not a
 * positive integer: silently dropping a bad id would turn a typo into "this
 * title is not streaming anywhere".
 */
export function parseTmdbIds(params: URLSearchParams): number[] | null | { error: string } {
  const raw = params.getAll("tmdbId").flatMap((v) => v.split(","));
  if (raw.length === 0) return null;
  const ids: number[] = [];
  for (const part of raw) {
    const value = part.trim();
    if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
      return { error: `tmdbId must be a positive integer (got "${value}").` };
    }
    ids.push(Number(value));
  }
  return ids;
}

/** The feed for one media type, optionally narrowed to some TMDB ids. */
export async function getFeed(
  kind: FeedKind,
  opts: { tmdbIds?: number[] | null } = {}
): Promise<Feed> {
  const rows = await prisma.mediaItem.findMany({
    where: {
      type: kind === "tv" ? "TV" : "MOVIE",
      onStreaming: true,
      skipped: false,
      ...(opts.tmdbIds ? { tmdbId: { in: opts.tmdbIds } } : {}),
    },
    // `id` breaks ties so the order — and with it the ETag — is stable between
    // two identical snapshots.
    orderBy: [{ title: "asc" }, { id: "asc" }],
    select: {
      title: true,
      year: true,
      tmdbId: true,
      tvdbId: true,
      imdbId: true,
      posterUrl: true,
      totalEpisodes: true,
      streamingEpisodes: true,
      providerSyncedAt: true,
      streamingInfo: true,
    },
  });
  const items = buildFeedItems(rows, kind);
  return { type: kind, generatedAt: new Date().toISOString(), count: items.length, items };
}

/**
 * Pull the feed key out of a request.
 *
 * Accepted, in order: `X-Api-Key` (the *arr-family convention most
 * self-hosted consumers already speak), `Authorization: Bearer <key>`, then
 * `?apikey=` / `?token=` for a consumer that can only be given a URL. Basic
 * auth is not taken, unlike the webhook: that exists for Sonarr's Connect
 * screen, and no feed consumer needs it.
 */
export function feedTokenFromRequest(req: { url: string; headers: Headers }): string | null {
  const header = req.headers.get("x-api-key");
  if (header?.trim()) return header.trim();

  const auth = req.headers.get("authorization");
  const bearer = auth ? /^Bearer\s+(.+)$/i.exec(auth) : null;
  if (bearer) return bearer[1].trim();

  const query = new URL(req.url).searchParams;
  return query.get("apikey") || query.get("token") || null;
}
