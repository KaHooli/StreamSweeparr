/**
 * Next.js instrumentation hook — runs once when the server process starts.
 *
 * It starts two background timers:
 *   1. The recurring (every 12h) Title ID map refresh, so the TMDB/IMDB ->
 *      Watchmode conversion table stays current without user action. The
 *      refresh is also invoked at the start of every sync (self-throttled), so
 *      this timer is a safety net for deployments that rarely sync.
 *   2. The sweep scheduler, which fires a sweep every N hours when the schedule
 *      is enabled in Settings -> Run options.
 */
export async function register() {
  // Only run in the Node.js server runtime (not edge / build).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Fail fast at boot if the session secret is missing/weak in production,
  // rather than at the first request. `assertAuthSecret` throws in production.
  const { assertAuthSecret } = await import("./lib/session");
  assertAuthSecret();

  // NOTE: the local admin account is reconciled with ADMIN_USERNAME /
  // ADMIN_PASSWORD by the login route (it calls ensureLocalAdmin() before
  // looking the user up), so env credentials work on the first login attempt.
  // We deliberately do NOT import lib/users here: this hook is also compiled
  // for the edge runtime, which cannot resolve node:crypto.

  // Allow opting out (e.g. multiple replicas — run the timer on one only).
  if (process.env.TITLE_MAP_SCHEDULER !== "off") {
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

  // Scheduled sweeps. The timer is cheap (one settings read a minute) and does
  // nothing until the schedule is enabled in Settings. Slots are claimed
  // atomically in the database, so running it on several replicas is safe;
  // SWEEP_SCHEDULER=off opts an instance out entirely.
  const { startSweepScheduler } = await import("./lib/scheduler");
  startSweepScheduler();
}
