# StreamSweeparr

A Seerr-style companion for Sonarr & Radarr. It finds which of your media is
available on the streaming services you subscribe to — using **Watchmode** for
**TV** (per-episode data) and **TheMovieDB / JustWatch** for **movies** — then:

1. **Unmonitors + deletes** monitored movies / TV episodes that are already on a
   selected streaming service (file deletion is optional).
2. **Re-monitors** unmonitored movies / episodes that have **left** all selected
   streaming services.
3. **Searches** every monitored movie / episode at the end of the run.

Runs are **dry-run by default** — nothing is changed until you enable LIVE mode.

---

## Architecture

```
                          ┌──────────────────────────────┐
   Browser (Dracula UI) ──►  Next.js 14 App Router        │
   dashboard / settings    │  ├─ React Server + Client    │
   / runs                  │  └─ API routes (/api/*)       │
                           └──────┬───────────────┬────────┘
                                  │               │
                    ┌─────────────▼───┐   ┌───────▼───────────┐
                    │ Business logic  │   │ External APIs      │
                    │  lib/sync.ts    │   │  Watchmode         │
                    │  lib/sweep.ts   │◄──┤  Sonarr v3         │
                    │  lib/watchmode  │   │  Radarr v3         │
                    │  lib/arr        │   │  Seerr (discovery) │
                    └────────┬────────┘   └────────────────────┘
                             │ Prisma
                    ┌────────▼────────┐
                    │  PostgreSQL      │  settings, connections,
                    │  (external)      │  media snapshot, run logs
                    └──────────────────┘
```

### Layers

| Concern | File(s) |
|---|---|
| DB client + settings bootstrap | `src/lib/db.ts` |
| Auth: sessions / passwords / users / OIDC | `src/lib/{session,password,users,oidc}.ts` |
| Route protection (edge middleware) | `src/middleware.ts` |
| Auth API (login, logout, session, change-password, OIDC) | `src/app/api/auth/**` |
| Login page | `src/app/login/page.tsx` |
| Watchmode client (regions, sources, title lookup, availability) | `src/lib/watchmode.ts` |
| Sonarr / Radarr / Seerr clients | `src/lib/arr.ts` |
| **Title ID map** — TMDB/IMDB → Watchmode id, imported from Watchmode's daily CSV | `src/lib/titlemap.ts` |
| 12h scheduler for the Title ID map | `src/instrumentation.ts` |
| **Sync engine** — snapshot library + streaming availability into Postgres | `src/lib/sync.ts` |
| **Sweep engine** — unmonitor/delete, re-monitor, search | `src/lib/sweep.ts` |
| Country flags | `src/lib/flags.ts` |
| REST API | `src/app/api/**` |
| UI (Dracula theme, dark/light/system) | `src/app/**`, `src/components/**`, `src/app/globals.css` |
| DB schema | `prisma/schema.prisma` |

### Title ID map (TMDB/IMDB → Watchmode id)
The Watchmode API is keyed on **Watchmode ids**, so every title from
Sonarr/Radarr must be converted from its TMDB/IMDB id first. Instead of spending
Watchmode **search** quota on every title, StreamSweeparr imports Watchmode's
daily [`title_id_map.csv`](https://api.watchmode.com/datasets/title_id_map.csv)
into the `TitleIdMap` table and resolves ids locally.

Refresh flow (`src/lib/titlemap.ts`), run at the start of every sync and on a
12-hour timer (`src/instrumentation.ts`):

1. **First run** → skip the ETag check.
2. Otherwise `HEAD` the CSV; if its **ETag** matches the last import, stop.
3. Download the CSV, recording **Last-Modified** + **ETag** for next time.
4. `TRUNCATE "TitleIdMap"` then stream-import the CSV via the Postgres `COPY`
   protocol (`pg` + `pg-copy-streams`) — works against any external Postgres.
5. Repeat at most every 12 hours.

`findTitleId()` tries this local map first and only falls back to the Watchmode
`/search` endpoint when a title is missing from the CSV. You can view status and
force a refresh under **Settings → Title ID map**, or via `POST /api/titlemap`
(`{ "force": true }` to bypass the window/ETag). Set `TITLE_MAP_SCHEDULER=off`
to disable the timer (e.g. on secondary replicas).

### Minimising Watchmode credit usage (TV)
TV availability is the only per-title Watchmode cost. Three layers keep it low:

1. **Local Title ID map** (above) resolves TMDB/IMDB → Watchmode id for free, so
   the metered `/search` endpoint is essentially never used.
2. **Change detection (paid plans).** Each sync asks
   `/changes/titles_episodes_changed` which title ids changed since the last
   sync (a few paginated calls total, independent of library size). Series that
   have **not** changed skip the per-series `/title/{id}/episodes/` call and
   reuse their cached availability. On a steady-state library this drops ongoing
   usage from *one call per series* to *near zero*.
   - The Changes API is a **premium (paid-plan) endpoint**. StreamSweeparr
     **auto-detects your plan** by probing the changes endpoint once (result
     cached, re-checked weekly): a paid key enables change-detection
     automatically; a free key falls back to layer 3 without ever making a
     failing call. The detected plan is shown under **Settings → Watchmode**.
3. **7-day freshness TTL.** Independent of the changes feed, a series whose
   availability was pulled within the last 7 days is not re-pulled. This is the
   safety net when the changes feed is unavailable or incomplete.

Additionally, a **LIVE sweep no longer re-syncs afterwards** — the DB snapshot
is updated in place as changes are applied, so it never doubles the Watchmode
pull. The run log reports how many episode fetches were made vs. skipped.

The first sync after setup still pulls every series once (nothing is cached
yet); every sync after that is cheap. To force a full re-pull, clear
`watchmodeChangesCursor` (and `providerSyncedAt`) — e.g. after changing your
selected countries/services.

### Authentication
The whole app is behind a login. A `middleware.ts` gate validates a signed,
edge-safe session cookie on every route except `/login` and `/api/auth/*`;
unauthenticated pages redirect to `/login`, unauthenticated API calls get `401`.

- **Username / password** — a default admin is seeded on first login:
  **username `admin`, password `0pen0pen&*`**. The account is flagged
  *must change password* and this is **enforced**: the middleware blocks every
  route except the change-password flow until a new password is set. Passwords
  are hashed with Node `scrypt`; sessions are HMAC-signed cookies
  (`src/lib/session.ts`) signed with `AUTH_SECRET`. Login is **rate-limited**
  per IP and per IP+username with progressive lockout (`src/lib/ratelimit.ts`).
- **OIDC SSO (optional)** — configure it under **Settings → Single sign-on
  (OIDC)** (issuer, client id/secret; endpoints auto-discovered from
  `/.well-known/openid-configuration`). When enabled, a **Sign in with SSO**
  button appears on the login page. Flow is Authorization Code + PKCE with
  `state` validation (`src/lib/oidc.ts`); users are provisioned on first login
  and can be restricted with an allow-list. The **first** user provisioned
  becomes admin; later SSO users are non-admin until promoted.
  - **Redirect URI:** register the exact value shown on the OIDC settings card
    with your provider. Behind a reverse proxy, set **`PUBLIC_URL`** (e.g.
    `https://sweep.example.com`) so the `redirect_uri` matches your public URL
    rather than the internal container address. A mismatch here is the usual
    cause of *"invalid or mismatching redirect_uri"* errors. The app otherwise
    derives the origin from `X-Forwarded-Proto`/`X-Forwarded-Host`, then `Host`.

Admin-only API routes (settings, connections, sync, sweep, title map) are
guarded server-side (`src/lib/auth.ts`) in addition to the middleware.

**`AUTH_SECRET` is required in production** — the app refuses to start without a
value of at least 16 characters (`openssl rand -hex 32`).

> **Running over plain HTTP?** In production the login cookie is marked `Secure`,
> which browsers only keep over HTTPS. If you access the app at `http://host:3000`
> (e.g. the default Docker Compose setup) the cookie is dropped and login appears
> to fail — you sign in but bounce back to the login screen. Set
> **`AUTH_COOKIE_INSECURE=true`** for HTTP deployments (the bundled
> `docker-compose.yml` already does this). Prefer putting the app behind HTTPS.

### SSRF protection
Any URL you supply (Sonarr/Radarr/Seerr base URLs, OIDC endpoints) is fetched
through `src/lib/safeFetch.ts`, which DNS-resolves the host and **always blocks**
loopback, link-local and the `169.254.169.254` cloud-metadata address, with a
request timeout and redirects disabled. Private LAN ranges are blocked unless
you set `SSRF_ALLOW_PRIVATE=true` (needed when your *arr apps run on a LAN).

### How availability is decided
Two providers, split by media type:

- **TV (Watchmode):** `matchSources()` in `watchmode.ts` keeps a title's
  Watchmode sources only if the `source_id` is one of your **selected services**
  *and* the source `type` (`sub`, `free`, `purchase`, `rent`, `tv_everywhere`)
  is a **counted type**. A series is "on streaming" if ≥1 episode matches.
- **Movies (TMDB):** `matchTmdbProviders()` in `tmdb.ts` keeps a movie's
  per-region providers only if the `provider_id` is one of your **selected
  providers** *and* the category (`flatrate`, `free`, `ads`, `rent`, `buy`) is a
  **counted type**. A movie is "on streaming" if it has ≥1 match.

Both drive the dashboard and the sweep decisions. Watchmode and TMDB are
configured on **separate tabs** under Settings.

### External API endpoints used
- **Watchmode (TV):** `/v1/regions/`, `/v1/sources/`, `/v1/search/` (fallback
  only), `/v1/title/{id}/episodes/`, `/v1/changes/titles_episodes_changed/`
  (paid plans; used for change detection), `/v1/status/` (auth via
  `X-API-Key`), plus the public `datasets/title_id_map.csv`.
- **TheMovieDB (movies):** `/3/watch/providers/regions`,
  `/3/watch/providers/movie`, `/3/movie/{id}/watch/providers`
  (auth via the `api_key` query param).
- **Sonarr v3:** `GET /series`, `GET /episode`, `PUT /episode/monitor`,
  `DELETE /episodefile/{id}`, `POST /command` (`EpisodeSearch`).
- **Radarr v3:** `GET /movie`, `PUT /movie/{id}`, `DELETE /moviefile/{id}`,
  `POST /command` (`MoviesSearch`).
- **Seerr (optional):** `GET /api/v1/settings/sonarr`, `.../radarr` to
  auto-discover instances.

---

## Requirements
- Node.js 18+ (tested on 20/26)
- An **external PostgreSQL** server (v13+)
- A **Watchmode** API key (for TV) — https://api.watchmode.com
- A **TheMovieDB (TMDB)** API key (for movies) — https://www.themoviedb.org
- One or more **Sonarr v3/v4** and/or **Radarr v3/v4** instances
  (optionally a **Seerr** server to auto-discover them)

> You only need the API key for the media types you use: Watchmode if you have a
> Sonarr connection, TMDB if you have a Radarr connection.

## Dependencies
Runtime: `next`, `react`, `react-dom`, `@prisma/client`, `pg`,
`pg-copy-streams`, `swr`, `zod`
Dev/build: `prisma`, `typescript`, `@types/*`, `eslint`, `eslint-config-next`

---

## How to run

### Option A — Local (Node + external Postgres)

```bash
# 1. Install
npm install

# 2. Configure env
cp .env.example .env
#   edit DATABASE_URL to point at your PostgreSQL server
#   set AUTH_SECRET (openssl rand -hex 32) — required in production
#   set SSRF_ALLOW_PRIVATE=true if your Sonarr/Radarr live on a private LAN

# 3. Apply database migrations
npm run prisma:migrate      # runs `prisma migrate deploy`

# 4a. Development
npm run dev            # http://localhost:3000

# 4b. Production
npm run build
npm run start
```

### Option B — Docker Compose (app + Postgres)

```bash
# Provide secrets first (compose refuses to start without AUTH_SECRET):
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> .env
docker compose up --build
# App: http://localhost:3000
```
The container's entrypoint runs `prisma migrate deploy` on start, so the schema
is created/updated automatically from the committed migrations.

> Using your **own** external Postgres with Docker? Remove the `db` service and
> set `DATABASE_URL` on the `app` service to your server.

---

## First-time setup (in the UI)
1. Open the app and **log in** with the default admin — username **`admin`**,
   password **`0pen0pen&*`** — then change the password under
   **Settings → Account & security**. (Optionally configure OIDC there too.)
1. Open **Settings** — it's organized into tabs.
2. **Watchmode (TV)** tab → paste your Watchmode key → *Test & save*. Then pick
   your **countries** (alphabetical, with flags) and **streaming services**
   (alphabetical, with logos), choosing which source types count.
3. **TheMovieDB (Movies)** tab → paste your TMDB key → *Test & save*. Then pick
   your **watch provider regions** (alphabetical, with flags) and, per region,
   the **movie providers** (alphabetical, with logos) you subscribe to, plus
   which categories count (Subscription / Free / Rent / Buy…).
4. **Connections** tab → either configure **Seerr** and click *Discover
   instances*, or add Sonarr/Radarr manually (URL + API key; the app verifies
   before saving).
5. **Run options** tab → leave **Apply changes** *off* for a safe dry-run first.
   Toggle **Delete files** and **Search at end** to taste.

## Running a sweep
From the **Dashboard**:
- **Sync now** — refresh the library + streaming availability snapshot.
- **Run sweep** — sync, then unmonitor/delete, re-monitor, and search. In
  dry-run it only records what *would* happen; check the **Runs** page for the
  full step-by-step log and counts.

Sync and sweep run **in the background** behind a single concurrency lock (only
one run at a time; stale runs are auto-reclaimed). The action bar returns
immediately and polls the run for **live progress**, so long runs no longer
block the request or the browser (`src/lib/jobs.ts`).

## Dashboard
- **TV shows on streaming** — each card shows a progress bar of how many
  episodes are **unmonitored** (with `x/total on streaming`).
- **Movies on streaming** — each card shows a **Monitored / Unmonitored** badge.

## Safety notes
- **Dry-run is the default.** No changes are made until **Apply changes (LIVE
  mode)** is enabled in Settings.
- **File deletion is destructive** and permanent. It only happens in LIVE mode
  with **Delete files** enabled, and only for titles found on your selected
  streaming services.
- **Transient Watchmode failures never cause churn.** When a title's streaming
  status can't be determined (lookup error or unmapped title), it is flagged
  *unknown* and the sweep will **not** re-monitor it — avoiding a mass
  re-monitor during a Watchmode outage.
- API keys are stored in your PostgreSQL database and are never returned to the
  browser (only a "configured" flag is exposed). *(Note: secrets are stored
  as-is; encrypting them at rest is a planned improvement — keep DB access
  restricted.)*

## Testing & CI
- `npm test` runs the Vitest unit suite (session tokens, password hashing,
  rate limiter, `matchSources`, the SSRF guard, flags).
- `npm run typecheck` / `npm run lint` for static checks.
- GitHub Actions (`.github/workflows/ci.yml`) gates every push/PR on
  lint + typecheck + test + build. The Docker image is published
  (`docker-publish.yml`) only from `main` and version tags.
```
