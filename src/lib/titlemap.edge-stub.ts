/**
 * Edge-runtime stub for lib/titlemap.
 *
 * The real implementation is Node-only (uses `pg` + node streams). Next.js
 * compiles the instrumentation hook for the edge runtime as well, so webpack is
 * pointed at this stub there (see next.config.mjs). These functions are never
 * actually called on the edge — instrumentation only runs its logic when
 * NEXT_RUNTIME === "nodejs", where the real module is used.
 */

export const TITLE_MAP_TTL_MS = 12 * 60 * 60 * 1000;

export interface TitleMapSyncResult {
  status: "imported" | "unchanged" | "skipped_recent";
  etag: string | null;
  lastModified: string | null;
  rowCount: number;
  reason?: string;
}

export async function refreshTitleMap(): Promise<TitleMapSyncResult> {
  throw new Error("refreshTitleMap is not available in the edge runtime.");
}

export async function lookupWatchmodeId(): Promise<number | null> {
  return null;
}
