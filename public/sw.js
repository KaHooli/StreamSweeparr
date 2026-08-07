/**
 * StreamSweeparr service worker.
 *
 * This app is multi-user and everything behind `/login` is per-account, so the
 * caching rules here are deliberately narrow:
 *
 *   - API responses (`/api/*`) are never touched. They carry one user's data
 *     (and, in Settings, connection secrets); a shared Cache Storage entry is
 *     exactly the wrong place for them.
 *   - HTML documents are never cached either. They are rendered per session,
 *     and a cached copy of an authenticated page — or of the `/login` redirect
 *     the proxy issues for an expired session — would outlive the session that
 *     produced it.
 *   - What *is* cached is the part of the app that is identical for everyone
 *     and safe to serve to anyone: Next's content-hashed build assets, the
 *     icons, the manifest, and the offline fallback page.
 *
 * That is enough to make the app installable, to make repeat loads fast, and to
 * show something other than the browser's dinosaur when the server is
 * unreachable — without turning the browser cache into a data leak.
 *
 * Bump VERSION when the precache list changes; `activate` drops every cache
 * that does not match the current name.
 */

const VERSION = "v1";
const CACHE = `streamsweeparr-static-${VERSION}`;
const OFFLINE_URL = "/offline.html";

/**
 * Fetched up front so a first-load-then-go-offline still has a fallback page.
 * Deliberately small: everything else fills in on demand.
 */
const PRECACHE = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/favicon.ico",
  "/icons/favicon-48x48.png",
  "/icons/pwa-192x192.png",
  "/icons/pwa-512x512.png",
];

/** Static, non-personal, safe to hand to any user of this browser. */
function isCacheableAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/favicon.ico" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === OFFLINE_URL
  );
}

/**
 * Only store responses that are ours, complete, and not a redirect. The
 * redirect check is the important one: an unauthenticated request for a guarded
 * path comes back as the login page, and caching that under the original URL
 * would pin the login screen in place after signing in.
 */
function isCacheableResponse(res) {
  return Boolean(res) && res.ok && res.type === "basic" && !res.redirected;
}

async function precache() {
  const cache = await caches.open(CACHE);
  // `cache.addAll` is all-or-nothing; one 404 would leave us with no fallback
  // page at all. Fetch each entry independently, bypassing the HTTP cache so a
  // redeploy refreshes the copies rather than re-storing stale ones.
  await Promise.all(
    PRECACHE.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: "reload", credentials: "same-origin" }));
        if (isCacheableResponse(res)) await cache.put(url, res);
      } catch {
        // Offline during install, or the asset moved. The runtime handlers below
        // degrade gracefully; failing the whole install would be worse.
      }
    })
  );
}

async function dropOldCaches() {
  const names = await caches.keys();
  await Promise.all(
    names.filter((n) => n.startsWith("streamsweeparr-") && n !== CACHE).map((n) => caches.delete(n))
  );
}

/** Cache-first. Used only for the immutable/static set above. */
async function serveAsset(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const res = await fetch(request);
  if (isCacheableResponse(res)) {
    // Clone before returning: the body can only be read once.
    cache.put(request, res.clone());
  }
  return res;
}

/**
 * Network-only, with the offline page as the fallback. Never writes to the
 * cache — see the note at the top about per-session HTML.
 */
async function serveDocument(request) {
  try {
    return await fetch(request);
  } catch (err) {
    const cache = await caches.open(CACHE);
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    throw err;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(dropOldCaches().then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Anything that changes state, or that is not ours, goes straight to the
  // network untouched.
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // User data and auth. Not ours to store, not ours to replay.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(serveDocument(request));
    return;
  }

  if (isCacheableAsset(url)) {
    event.respondWith(serveAsset(request));
  }

  // Everything else (RSC payloads, anything unrecognised) falls through to the
  // browser's own handling.
});

// Lets a freshly loaded page hand over to a waiting worker instead of waiting
// for every tab to close.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
