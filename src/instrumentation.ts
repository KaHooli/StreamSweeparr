/**
 * Next.js instrumentation hook — runs once when the server process starts.
 *
 * It starts three background timers:
 *   1. The recurring (every 12h) Title ID map refresh, so the TMDB/IMDB ->
 *      Watchmode conversion table stays current without user action. The
 *      refresh is also invoked at the start of every sync (self-throttled), so
 *      this timer is a safety net for deployments that rarely sync.
 *   2. The sweep scheduler, which fires a sweep every N hours when the schedule
 *      is enabled in Settings -> Run options.
 *   3. The webhook sweep queue worker, which sweeps titles Sonarr/Radarr told
 *      us about as they were added.
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

  // Convert any plaintext credentials left by an older version to ciphertext.
  // A SQL migration cannot do this: the key is derived from AUTH_SECRET, which
  // only the application can see. Idempotent, so it is safe on every boot, and
  // non-fatal — reads handle both forms, so a database that is briefly
  // unreachable at startup only delays the conversion.
  {
    const { encryptStoredSecrets } = await import("./lib/secrets");
    const { logger } = await import("./lib/logger");
    const log = logger("secrets");
    try {
      const migrated = await encryptStoredSecrets();
      const total = migrated.settingsFields + migrated.connections;
      if (total > 0) {
        log.info(
          `encrypted ${migrated.settingsFields} stored setting(s) and ` +
            `${migrated.connections} connection key(s) at rest.`
        );
      }
    } catch (e) {
      log.error(`could not encrypt stored credentials at boot: ${(e as Error).message}`);
    }
  }

  // Allow opting out (e.g. multiple replicas — run the timer on one only).
  if (process.env.TITLE_MAP_SCHEDULER !== "off") {
    const { refreshTitleMap, TITLE_MAP_TTL_MS } = await import("./lib/titlemap");
    const { logger } = await import("./lib/logger");
    const log = logger("titlemap");

    const tick = async () => {
      try {
        const r = await refreshTitleMap();
        log.info(`scheduled refresh: ${r.status} (${r.rowCount} rows)`);
      } catch (e) {
        log.error(`scheduled refresh failed: ${(e as Error).message}`);
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

  // Webhook-triggered sweeps. The receiving endpoint only queues titles; this
  // worker is what turns the queue into runs. Like the scheduler it is a cheap
  // poll that does nothing until the feature is switched on in Settings, claims
  // work atomically so replicas can share it, and honours SWEEP_SCHEDULER=off.
  const { startSweepQueueWorker } = await import("./lib/sweepQueue");
  startSweepQueueWorker();
}
