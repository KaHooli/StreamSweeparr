/**
 * Next.js instrumentation hook — runs once when the server process starts.
 * We use it to schedule the recurring (every 12h) Title ID map refresh so the
 * TMDB/IMDB -> Watchmode conversion table stays current without user action.
 *
 * The refresh is also invoked at the start of every sync (self-throttled), so
 * this timer is a safety net for long-running deployments that rarely sync.
 */
export async function register() {
  // Only run in the Node.js server runtime (not edge / build).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Allow opting out (e.g. multiple replicas — run the timer on one only).
  if (process.env.TITLE_MAP_SCHEDULER === "off") return;

  const { refreshTitleMap, TITLE_MAP_TTL_MS } = await import("./lib/titlemap");

  const tick = async () => {
    try {
      const r = await refreshTitleMap();
      // eslint-disable-next-line no-console
      console.log(`[titlemap] scheduled refresh: ${r.status} (${r.rowCount} rows)`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[titlemap] scheduled refresh failed: ${(e as Error).message}`);
    }
  };

  // Kick off shortly after boot (so the DB is reachable), then every 12h.
  setTimeout(tick, 10_000);
  const timer = setInterval(tick, TITLE_MAP_TTL_MS);
  // Do not keep the event loop alive solely for this timer.
  if (typeof timer.unref === "function") timer.unref();
}
