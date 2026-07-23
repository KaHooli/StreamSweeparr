/**
 * Watchmode Title ID map dataset.
 *
 * Downloads https://api.watchmode.com/datasets/title_id_map.csv and imports it
 * into the `TitleIdMap` table so we can convert TMDB/IMDB ids -> Watchmode id
 * locally instead of spending Watchmode search-endpoint quota.
 *
 * Refresh flow (per spec):
 *   1. First run -> skip the etag check.
 *   2. Otherwise HEAD the CSV; if the etag matches the last run, stop.
 *   3. Download the CSV, recording last-modified + etag for next time.
 *   4. Truncate TitleIdMap and COPY the CSV into it.
 *   5. Runs at most once every 12 hours (enforced by the scheduler / API).
 *
 * The import uses the Postgres COPY protocol via `pg-copy-streams`, which
 * streams straight into the server and works against any external PostgreSQL.
 */

import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { prisma, getSettings } from "./db";

// `pg` and `pg-copy-streams` are Node-only and pull in `fs`/`net`/`tls`. They
// are imported lazily inside runImport() so they never enter the edge/
// instrumentation bundle that Next.js builds.

const CSV_URL = "https://api.watchmode.com/datasets/title_id_map.csv";
export const TITLE_MAP_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface TitleMapSyncResult {
  status: "imported" | "unchanged" | "skipped_recent";
  etag: string | null;
  lastModified: string | null;
  rowCount: number;
  reason?: string;
}

/**
 * Header validators for the current remote dataset. Uses HEAD so we do not pull
 * ~78MB just to compare etags.
 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`Request to ${url} timed out.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchValidators(): Promise<{ etag: string | null; lastModified: string | null }> {
  const res = await fetchWithTimeout(CSV_URL, { method: "HEAD", cache: "no-store" }, 15_000);
  if (!res.ok) throw new Error(`Could not HEAD title_id_map.csv (${res.status}).`);
  return {
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
  };
}

/**
 * A Transform that rewrites Watchmode's quoted CSV into a header-less stream
 * with exactly the columns TitleIdMap expects, in table-column order:
 *   watchmodeId, imdbId, tmdbId, tmdbType, title, year
 *
 * We re-emit as tab-separated values with \N for NULL, which is COPY's default
 * text format and avoids quoting/escaping ambiguity in the movie titles.
 */
function makeCsvToCopyTransform() {
  let leftover = "";
  let headerSkipped = false;

  const parseLine = (line: string): string[] => {
    // Minimal RFC-4180 parser: handles quoted fields + escaped quotes ("").
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };

  const esc = (v: string): string => {
    // COPY text-format escaping for tab/newline/backslash; empty -> NULL (\N).
    if (v === "") return "\\N";
    return v
      .replace(/\\/g, "\\\\")
      .replace(/\t/g, "\\t")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r");
  };

  const emit = (line: string): string | null => {
    if (!line.length) return null;
    const cols = parseLine(line);
    // CSV order: Watchmode ID, IMDB ID, TMDB ID, TMDB Type, Title, Year
    const [wm, imdb, tmdb, tmdbType, title, year] = cols;
    if (!wm || !/^\d+$/.test(wm.trim())) return null; // skip malformed rows
    const tmdbNum = tmdb && /^\d+$/.test(tmdb.trim()) ? tmdb.trim() : "";
    const yearNum = year && /^\d+$/.test(year.trim()) ? year.trim() : "";
    return (
      [
        esc(wm.trim()),
        esc(imdb ?? ""),
        esc(tmdbNum),
        esc(tmdbType ?? ""),
        esc(title ?? ""),
        esc(yearNum),
      ].join("\t") + "\n"
    );
  };

  return new Transform({
    transform(chunk, _enc, cb) {
      leftover += chunk.toString("utf8");
      const lines = leftover.split("\n");
      leftover = lines.pop() ?? "";
      let buf = "";
      for (let raw of lines) {
        raw = raw.replace(/\r$/, "");
        if (!headerSkipped) {
          headerSkipped = true; // drop the CSV header row
          continue;
        }
        const row = emit(raw);
        if (row) buf += row;
      }
      cb(null, buf);
    },
    flush(cb) {
      if (leftover.trim().length && headerSkipped) {
        const row = emit(leftover.replace(/\r$/, ""));
        if (row) return cb(null, row);
      }
      cb();
    },
  });
}

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  return url;
}

/**
 * Run the full refresh flow. Pass `force: true` to bypass both the 12h window
 * and the etag short-circuit (still records validators).
 */
export async function refreshTitleMap(opts: { force?: boolean } = {}): Promise<TitleMapSyncResult> {
  const settings = await getSettings();
  const firstRun = !settings.titleMapSyncedAt;

  // Step 5 (enforced here): honour the 12h window unless forced.
  if (!opts.force && settings.titleMapSyncedAt) {
    const age = Date.now() - settings.titleMapSyncedAt.getTime();
    if (age < TITLE_MAP_TTL_MS) {
      return {
        status: "skipped_recent",
        etag: settings.titleMapEtag,
        lastModified: settings.titleMapLastModified,
        rowCount: settings.titleMapRowCount,
        reason: `Last import ${Math.round(age / 3600000)}h ago; within 12h window.`,
      };
    }
  }

  // Steps 1 & 2: etag check (skipped on first run or when forced).
  const validators = await fetchValidators();
  if (!firstRun && !opts.force && validators.etag && validators.etag === settings.titleMapEtag) {
    // Unchanged: just bump the synced-at clock so we don't re-check for 12h.
    await prisma.settings.update({
      where: { id: 1 },
      data: { titleMapSyncedAt: new Date(), titleMapLastModified: validators.lastModified },
    });
    return {
      status: "unchanged",
      etag: validators.etag,
      lastModified: validators.lastModified,
      rowCount: settings.titleMapRowCount,
      reason: "ETag matches previous import.",
    };
  }

  // Step 3: download the CSV (~78MB) — allow a generous timeout.
  const res = await fetchWithTimeout(CSV_URL, { cache: "no-store" }, 120_000);
  if (!res.ok || !res.body) throw new Error(`Failed to download title_id_map.csv (${res.status}).`);
  const etag = res.headers.get("etag") ?? validators.etag;
  const lastModified = res.headers.get("last-modified") ?? validators.lastModified;

  // Step 4: truncate + COPY into a raw pg connection.
  const { Client } = await import("pg");
  const { from: copyFrom } = await import("pg-copy-streams");
  const client = new Client({ connectionString: getDatabaseUrl() });
  await client.connect();
  let rowCount = 0;
  try {
    // Wrap TRUNCATE + COPY in a transaction so a failure mid-import rolls back
    // and leaves the previous map intact (rather than an empty table).
    await client.query("BEGIN");
    try {
      await client.query('TRUNCATE TABLE "TitleIdMap"');
      // client.query(copyFrom(...)) returns the Writable COPY stream.
      const copyStream = client.query(
        copyFrom(
          'COPY "TitleIdMap" ("watchmodeId","imdbId","tmdbId","tmdbType","title","year") FROM STDIN'
        ) as unknown as Parameters<typeof client.query>[0]
      ) as unknown as NodeJS.WritableStream;
      // Node's fetch body is a web ReadableStream; adapt to a Node Readable.
      const nodeBody = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      await pipeline(nodeBody, makeCsvToCopyTransform(), copyStream);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }

    const count = await client.query('SELECT COUNT(*)::int AS c FROM "TitleIdMap"');
    rowCount = count.rows[0]?.c ?? 0;
  } finally {
    await client.end();
  }

  await prisma.settings.update({
    where: { id: 1 },
    data: {
      titleMapEtag: etag,
      titleMapLastModified: lastModified,
      titleMapSyncedAt: new Date(),
      titleMapRowCount: rowCount,
    },
  });

  return { status: "imported", etag, lastModified, rowCount };
}

/** Resolve a Watchmode id from the local map. Returns null if not found. */
export async function lookupWatchmodeId(opts: {
  tmdbId?: number | null;
  imdbId?: string | null;
  type: "movie" | "tv";
}): Promise<number | null> {
  if (opts.tmdbId) {
    const row = await prisma.titleIdMap.findFirst({
      where: { tmdbId: opts.tmdbId, tmdbType: opts.type },
      select: { watchmodeId: true },
    });
    if (row) return row.watchmodeId;
    // Fall back to a type-agnostic TMDB match.
    const any = await prisma.titleIdMap.findFirst({
      where: { tmdbId: opts.tmdbId },
      select: { watchmodeId: true },
    });
    if (any) return any.watchmodeId;
  }
  if (opts.imdbId) {
    const row = await prisma.titleIdMap.findFirst({
      where: { imdbId: opts.imdbId },
      select: { watchmodeId: true },
    });
    if (row) return row.watchmodeId;
  }
  return null;
}
