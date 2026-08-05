<div align="center">

<img src="public/icons/pwa-256x256.png" alt="StreamSweeparr" width="140" />

# StreamSweeparr

**A Seerr-style companion for Sonarr &amp; Radarr that cleans up media you can already stream.**

[![CI](https://github.com/KaHooli/StreamSweeparr/actions/workflows/ci.yml/badge.svg)](https://github.com/KaHooli/StreamSweeparr/actions/workflows/ci.yml)
[![Docker image](https://img.shields.io/badge/ghcr.io-streamsweeparr-2496ed?logo=docker&logoColor=white)](https://github.com/KaHooli/StreamSweeparr/pkgs/container/streamsweeparr)
[![Next.js 14](https://img.shields.io/badge/Next.js-14-black?logo=nextdotjs)](https://nextjs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-13%2B-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org)

</div>

---

## What it does

StreamSweeparr checks your Sonarr/Radarr library against the streaming services
you actually subscribe to — **Watchmode** for TV (per-episode data) and
**TheMovieDB / JustWatch** for movies — and then keeps your library tidy:

| | Action | What happens |
|---|---|---|
| 🧹 | **Sweep** | Unmonitors (and optionally deletes) movies / episodes that are already on a selected streaming service |
| 🔁 | **Re-monitor** | Re-monitors anything that has **left** all of your selected services |
| 🔍 | **Search** | Triggers a Sonarr/Radarr search for every monitored movie / episode at the end of a run |

> [!IMPORTANT]
> Runs are **dry-run by default** — nothing is changed until you enable LIVE mode.
> Tag anything `ss-skip` in Sonarr/Radarr to exclude it entirely
> ([details](#-excluding-titles-the-ss-skip-tag)).

---

## Table of contents

- [Requirements](#-requirements)
- [Quick start](#-quick-start)
- [First-time setup](#-first-time-setup-in-the-ui)
- [Running a sweep](#-running-a-sweep)
- [The dashboard](#-the-dashboard)
- [Behaviour &amp; options](#-behaviour--options)
  - [Scheduled sweeps](#-scheduled-sweeps)
  - [Excluding titles: the `ss-skip` tag](#-excluding-titles-the-ss-skip-tag)
  - [Clearing files for unmonitored titles](#-clearing-files-for-unmonitored-titles)
  - [Movies deleted from TMDB](#-movies-deleted-from-tmdb)
  - [How availability is decided](#-how-availability-is-decided)
  - [Minimising Watchmode credit usage](#-minimising-watchmode-credit-usage-tv)
- [Authentication &amp; security](#-authentication--security)
- [Environment variables](#-environment-variables)
- [Safety notes](#-safety-notes)
- [Architecture](#-architecture)
- [Development, testing &amp; CI](#-development-testing--ci)

---

## 📋 Requirements

- **Node.js 18+** (tested on 20/26) — or just Docker
- An **external PostgreSQL** server (v13+)
- A **[Watchmode](https://api.watchmode.com)** API key — for TV
- A **[TheMovieDB](https://www.themoviedb.org)** API key — for movies
- One or more **Sonarr v3/v4** and/or **Radarr v3/v4** instances
  (optionally a **Seerr** server to auto-discover them)

> [!TIP]
> You only need the API key for the media types you use: Watchmode if you have a
> Sonarr connection, TMDB if you have a Radarr connection.

---

## 🚀 Quick start

### Option A — Docker Compose (app + Postgres) &nbsp;·&nbsp; *recommended*

```bash
# Provide secrets first — compose refuses to start without AUTH_SECRET:
echo "AUTH_SECRET=$(openssl rand -hex 32)"     >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> .env

docker compose up --build
# → http://localhost:3000
```

The container entrypoint runs `prisma migrate deploy` on start, so the schema is
created and updated automatically from the committed migrations.

<details>
<summary>Using your own external Postgres?</summary>

Remove the `db` service from `docker-compose.yml` and point `DATABASE_URL` on
the `app` service at your own server.

</details>

### Option B — Local (Node + external Postgres)

```bash
# 1. Install
npm install

# 2. Configure env
cp .env.example .env
#   • DATABASE_URL   → your PostgreSQL server
#   • AUTH_SECRET    → openssl rand -hex 32   (required in production)
#   • SSRF_ALLOW_PRIVATE=true if Sonarr/Radarr live on a private LAN

# 3. Apply database migrations
npm run prisma:migrate      # runs `prisma migrate deploy`

# 4a. Development
npm run dev                 # → http://localhost:3000

# 4b. Production
npm run build && npm run start
```

---

## 🛠 First-time setup (in the UI)

1. **Log in** with the default admin — username **`admin`**, password
   **`0pen0pen&*`** (or whatever you set via `ADMIN_USERNAME` / `ADMIN_PASSWORD`).
   You'll be required to set a new password, and can rename the account, under
   **Settings → Users &amp; security**. OIDC, login options and user roles live on
   that tab too.
2. **Settings → Watchmode (TV)** — paste your Watchmode key → *Test &amp; save*.
   Then pick your **countries** (alphabetical, with flags) and **streaming
   services** (alphabetical, with logos), choosing which source types count.
3. **Settings → TheMovieDB (Movies)** — paste your TMDB key → *Test &amp; save*.
   Then pick your **watch provider regions** and, per region, the **movie
   providers** you subscribe to, plus which categories count (Subscription /
   Free / Rent / Buy…).
4. **Settings → Connections** — either configure **Seerr** and click *Discover
   instances*, or add Sonarr/Radarr manually (URL + API key; the app verifies
   before saving).
5. **Settings → Run options** — leave **Apply changes** *off* for a safe dry-run
   first. Toggle **Delete files** and **Search at end** to taste. **Remove files
   for all unmonitored items** is off by default — see
   [Clearing files for unmonitored titles](#-clearing-files-for-unmonitored-titles).
   Once you're happy with a manual run, **Scheduled sweeps** can repeat it every
   few hours — see [Scheduled sweeps](#-scheduled-sweeps).

---

## ▶️ Running a sweep

From the **Dashboard**:

| Button | What it does |
|---|---|
| **Sync now** | Refreshes the library + streaming availability snapshot |
| **Run sweep** | Syncs, then unmonitors/deletes, re-monitors, and searches |

In dry-run mode a sweep only records what *would* happen — check the **Runs**
page for the full step-by-step log and counts.

Sync and sweep run **in the background** behind a single concurrency lock (only
one run at a time; stale runs are auto-reclaimed). The action bar returns
immediately and polls the run for **live progress**, so long runs never block
the request or the browser (`src/lib/jobs.ts`).

To run sweeps automatically instead — e.g. every 12 hours — see
[Scheduled sweeps](#-scheduled-sweeps).

---

## 📊 The dashboard

- **TV shows on streaming** — each card shows a progress bar of how many
  episodes are **unmonitored** (with `x/total on streaming`).
- **Movies on streaming** — each card shows a **Monitored / Unmonitored** badge.
- **Provider logos** under each card link straight to the title on that service,
  using Watchmode's `web_url` (never `ios_url`/`android_url`, which are
  app-scheme links a browser can't open).

<details>
<summary>Why some TV logos aren't clickable</summary>

Watchmode only returns *per-episode* links on paid plans — free plans get the
placeholder `"Episode links available for paid plans only."`, which is
discarded — so for TV the **show-level** `/title/{id}/sources/` links are
fetched instead. That lookup is on its own schedule
(`MediaItem.providerLinksSyncedAt`, same 7-day TTL) rather than the episode one,
so a show doesn't sit on unlinked logos for a week just because its availability
is still fresh, and it only runs for shows that are actually missing a link.
Results are stored in `streamingInfo` and reused from then on.

If Watchmode has no link for a source at all, that logo is rendered without a
link — a TV logo never points anywhere but the service itself — and the run log
says how many shows that affected. Movies always use the TMDB page, since TMDB
gives availability but no per-provider link.

</details>

---

## ⚙️ Behaviour &amp; options

### ⏱ Scheduled sweeps

**Settings → Run options → Scheduled sweeps** runs a sweep on a timer, so you
don't have to press **Run sweep** yourself. Turn on **Run sweep at regular
intervals** and pick how often — every **1, 2, 3, 4, 6, 8 or 12 hours**, or
every **1, 2, 3 or 7 days**. The card shows when the next run is due and when
the last scheduled one started.

A scheduled sweep is exactly the sweep the button runs, so it obeys every other
run option — most importantly **Apply changes**: with LIVE mode off the schedule
is a recurring *dry-run* that only logs what it would do. Each run appears on
the **Runs** page like any other, and its log opens with
`Starting scheduled … sweep (every 12 hours).`

Details worth knowing:

- **The countdown survives restarts.** The next due time is stored in the
  database, not in the process, so restarting the container doesn't reset it.
- **Turning the schedule on never fires immediately** — the first run is one
  full interval away. Changing the interval re-anchors on the last scheduled run
  (never in the past), so shortening it takes effect straight away.
- **Missed slots are skipped, not replayed.** If the app was down for a day, it
  runs once when it comes back, not once per missed slot.
- **Overlaps are skipped, not queued.** If a sync or sweep is already running,
  the scheduled one is dropped and picks up at the next interval — the run lock
  in `src/lib/jobs.ts` is the single source of truth.
- **Multiple replicas are safe.** A slot is claimed with a conditional update on
  the settings row, so exactly one instance fires it. Set `SWEEP_SCHEDULER=off`
  to opt an instance out entirely.

### 🏷 Excluding titles: the `ss-skip` tag

Add the tag **`ss-skip`** (case-insensitive) to any series in Sonarr or movie in
Radarr and StreamSweeparr will leave it completely alone:

- its streaming availability is **never looked up** (so it costs no API quota),
- its monitored/unmonitored state is **never changed**,
- its files are **never deleted**, and
- it is **excluded from the end-of-run search**.

Tagged titles are marked `skipped` in the database and don't appear in the
"on streaming" lists, since the tool deliberately has no availability data for
them. Remove the tag and the next sync picks the title back up. The run log
reports how many titles were ignored this way.

### 🗑 Clearing files for unmonitored titles

**Delete files when unmonitoring** only covers titles the sweep unmonitors *that
run*. Anything already unmonitored — a back-catalogue you unmonitored by hand,
or titles swept before you turned file deletion on — keeps its files forever.

**Settings → Run options → Remove files for all unmonitored items** closes that
gap: at the end of a sweep, every movie and episode still unmonitored has its
file deleted. Monitoring is never changed, since those titles are already
unmonitored.

It is **off by default** so upgrading never retroactively wipes an existing
library, and like every destructive action it is LIVE-mode only — a dry-run
reports `Would delete file for … (unmonitored)`. Two things are deliberately out
of scope:

- titles being **re-monitored** this run (they left streaming, so they end the
  sweep monitored and their files are kept), and
- `ss-skip` tagged titles, which are never touched.

Note this is a superset of **Delete files when unmonitoring**: with it enabled,
files are removed from unmonitored titles even if that narrower toggle is off.

### 🎬 Movies deleted from TMDB

TMDB sometimes deletes or merges entries — typically cancelled or never-produced
films — leaving Radarr holding an id that no longer resolves. Those lookups fail
with `404 / status_code 34`.

StreamSweeparr treats that as definitive (transient problems surface as
5xx/429/timeouts, never 404): the movie is flagged during sync, and the **sweep**
removes it from Radarr. **Media files are kept** and no import exclusion is
added, so the title can simply be re-added if it was removed in error.

Like every destructive action this only happens in **LIVE mode** — a dry-run
just reports `Would remove …`. Turn it off with **Settings → Run options →
Remove movies deleted from TMDB**. Removals are counted on the **Runs** page.

### 🧮 How availability is decided

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

### 💳 Minimising Watchmode credit usage (TV)

TV availability is the only per-title Watchmode cost. Three layers keep it low:

1. **Local Title ID map** resolves TMDB/IMDB → Watchmode id for free, so the
   metered `/search` endpoint is essentially never used
   ([how it works](#title-id-map-tmdbimdb--watchmode-id)).
2. **Change detection (paid plans).** Each sync asks
   `/changes/titles_episodes_changed` which title ids changed since the last
   sync (a few paginated calls total, independent of library size). Series that
   have **not** changed skip the per-series `/title/{id}/episodes/` call and
   reuse their cached availability. On a steady-state library this drops ongoing
   usage from *one call per series* to *near zero*.
   - The Changes API is a **premium (paid-plan) endpoint**. StreamSweeparr
     **auto-detects your plan** by probing it once (result cached, re-checked
     weekly): a paid key enables change-detection automatically; a free key
     falls back to layer 3 without ever making a failing call. The detected plan
     is shown under **Settings → Watchmode**.
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

**Movies (TMDB)** get the same treatment on a shorter clock. TMDB has no
changes feed, so freshness is purely time-based: a movie looked up successfully
within the last **24 hours** is served from the cached answer instead of being
re-fetched. On a 12-hourly schedule that halves TMDB traffic; a title whose
lookup failed, or that has just had its `ss-skip` tag removed, is always
re-checked. The run log reports calls made vs. served from cache.

Sync also looks titles up **in parallel** (`SYNC_CONCURRENCY`, default 4).
Sync is almost entirely waiting on HTTP, so this is what turns a large library's
sync from minutes of latency into something much shorter.

#### Title ID map (TMDB/IMDB → Watchmode id)

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

---

## 🔐 Authentication &amp; security

The whole app is behind a login. A `middleware.ts` gate validates a signed,
edge-safe session cookie on every route except `/login` and `/api/auth/*`;
unauthenticated pages redirect to `/login`, unauthenticated API calls get `401`.

**Roles.** Every account is either **admin** (full access: settings,
connections, sync/sweep, user management) or **user** (read-only dashboard and
run history). Admin-only API routes are guarded server-side (`src/lib/auth.ts`)
in addition to the middleware.

### Username / password (always an admin)

There is exactly one local account and it always has the **admin** role. It's
seeded on first login as **`admin` / `0pen0pen&*`** and flagged *must change
password*, which is **enforced**: the middleware blocks every route except the
change-password flow until a new password is set.

- **Rename it** any time under **Settings → Users &amp; security → Your account**.
- **Set it from the environment** with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
  While set, these stay authoritative (so the credentials in your compose file
  always work, and you have a password-recovery path); supplying
  `ADMIN_PASSWORD` also skips the forced password change, since you chose it.
- Passwords are hashed with Node `scrypt`; sessions are HMAC-signed cookies
  (`src/lib/session.ts`) signed with `AUTH_SECRET`. Login is **rate-limited**
  per IP and per IP+username with progressive lockout (`src/lib/ratelimit.ts`).

### OIDC single sign-on (optional)

Configure it under **Settings → Single sign-on (OIDC)** (issuer, client
id/secret; endpoints auto-discovered from `/.well-known/openid-configuration`).
When enabled, a **Sign in with SSO** button appears on the login page. Flow is
Authorization Code + PKCE with `state` validation (`src/lib/oidc.ts`); users are
provisioned on first login and can be restricted with an allow-list. **New SSO
users get the `user` role** — an admin promotes them under **Settings → Users &amp;
security → Users**, which lists every account with its provider and role.

> [!WARNING]
> **Redirect URI:** register the exact value shown on the OIDC settings card
> with your provider. Behind a reverse proxy, set **`PUBLIC_URL`** (e.g.
> `https://sweep.example.com`) so the `redirect_uri` matches your public URL
> rather than the internal container address. A mismatch here is the usual cause
> of *"invalid or mismatching redirect_uri"* errors. The app otherwise derives
> the origin from `X-Forwarded-Proto`/`X-Forwarded-Host`, then `Host`.

### Hiding the password form (SSO-only)

Under **Settings → Users &amp; security → Login options** you can turn off
username/password login so only SSO is offered (also settable with
`LOCAL_LOGIN_DISABLED=true`). This is only permitted while OIDC is enabled *and*
fully configured — otherwise the toggle is greyed out and the form stays on, so
you can't lock yourself out. It's enforced server-side, not just hidden in the
UI. If SSO ever breaks while this is off, set `LOCAL_LOGIN_DISABLED=false` to
force the password form back on.

Safety rails: the instance can never be left without an admin, the local
password account can't be demoted or deleted, and you can't delete your own
account.

**`AUTH_SECRET` is required in production** — the app refuses to start without a
value of at least 16 characters (`openssl rand -hex 32`).

> [!CAUTION]
> **Running over plain HTTP?** In production the login cookie is marked `Secure`,
> which browsers only keep over HTTPS. If you access the app at
> `http://host:3000` (e.g. the default Docker Compose setup) the cookie is
> dropped and login appears to fail — you sign in but bounce back to the login
> screen. Set **`AUTH_COOKIE_INSECURE=true`** for HTTP deployments (the bundled
> `docker-compose.yml` already does this). Prefer putting the app behind HTTPS.

### SSRF protection

Any URL you supply (Sonarr/Radarr/Seerr base URLs, OIDC endpoints) is fetched
through `src/lib/safeFetch.ts`, which DNS-resolves the host and **always blocks**
loopback, link-local and the `169.254.169.254` cloud-metadata address, with a
request timeout and redirects disabled. Private LAN ranges are blocked unless
you set `SSRF_ALLOW_PRIVATE=true` (needed when your *arr apps run on a LAN).

---

## 🔧 Environment variables

Everything else is configured in the UI — see [`.env.example`](.env.example) for
the fully commented version.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string. On 1–2 vCPU hosts append `&connection_limit=10&pool_timeout=20` |
| `AUTH_SECRET` | ✅ (prod) | Signs session cookies. ≥16 chars — `openssl rand -hex 32` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | — | Seed **and** keep authoritative the local admin account |
| `LOCAL_LOGIN_DISABLED` | — | `true` hides the password form (SSO-only); `false` forces it back on |
| `AUTH_COOKIE_INSECURE` | — | `true` when serving over plain HTTP, or login silently fails |
| `PUBLIC_URL` | — | Public origin behind a reverse proxy; fixes the OIDC `redirect_uri` |
| `TRUST_PROXY` | — | `true` to believe `X-Forwarded-For/Proto/Host`. Only with a proxy that overwrites them — see below |
| `OIDC_REDIRECT_URI` | — | Override the OIDC callback outright (rarely needed) |
| `SSRF_ALLOW_PRIVATE` | — | `true` to allow private LAN ranges (needed for LAN *arr apps) |
| `SYNC_CONCURRENCY` | — | Titles looked up in parallel during a sync (default `4`, max `32`) |
| `LOG_LEVEL` | — | `debug` / `info` / `warn` / `error` for background work (default `info`) |
| `TITLE_MAP_SCHEDULER` | — | `off` disables the 12h Title ID map refresh on this instance |
| `SWEEP_SCHEDULER` | — | `off` stops this instance running [scheduled sweeps](#-scheduled-sweeps) (the schedule itself stays configured) |
| `PORT` | — | Port for `next start` (default `3000`) |

### Running behind a reverse proxy

`X-Forwarded-*` headers are only meaningful when something you control
overwrites them. If the app is reachable directly, any client can forge them —
and since the login rate limiter buckets by client IP, a forged header would let
an attacker pick a fresh bucket for every attempt. So they are ignored unless
you set `TRUST_PROXY=true`.

With `TRUST_PROXY` off, per-IP login throttling effectively collapses into one
bucket; the per-username and instance-wide limiters still apply, so brute force
is still bounded. Behind a real proxy, set `TRUST_PROXY=true` **and**
`PUBLIC_URL`.

---

## 🛡 Safety notes

- **Dry-run is the default.** No changes are made until **Apply changes (LIVE
  mode)** is enabled in Settings.
- **File deletion is destructive** and permanent. It only happens in LIVE mode.
  With **Delete files when unmonitoring** it is limited to titles found on your
  selected streaming services; **Remove files for all unmonitored items** widens
  it to every unmonitored title, so enable that one deliberately.
- **Transient Watchmode failures never cause churn.** When a title's streaming
  status can't be determined (lookup error or unmapped title), it is flagged
  *unknown* and the sweep will **not** re-monitor it — avoiding a mass
  re-monitor during a Watchmode outage.
- API keys are stored in your PostgreSQL database and are never returned to the
  browser (only a "configured" flag is exposed). *(Note: secrets are stored
  as-is; encrypting them at rest is a planned improvement — keep DB access
  restricted.)*
- **Sessions are revocable.** Changing a user's role, changing a password, or
  deleting an account bumps that account's `tokenVersion`, and every
  server-side guard re-reads the account on each request. A demoted admin loses
  admin rights on their *next* request rather than when their cookie expires.

---

## 🏗 Architecture

```
                          ┌──────────────────────────────┐
   Browser (Dracula UI) ──►  Next.js 14 App Router        │
   dashboard / settings    │  ├─ React Server + Client    │
   / runs                  │  └─ API routes (/api/*)      │
                           └──────┬───────────────┬───────┘
                                  │               │
                    ┌─────────────▼───┐   ┌───────▼────────────┐
                    │ Business logic  │   │ External APIs      │
                    │  lib/sync.ts    │   │  Watchmode         │
                    │  lib/sweep.ts   │◄──┤  Sonarr v3         │
                    │  lib/watchmode  │   │  Radarr v3         │
                    │  lib/arr        │   │  Seerr (discovery) │
                    └────────┬────────┘   └────────────────────┘
                             │ Prisma
                    ┌────────▼─────────┐
                    │  PostgreSQL      │  settings, connections,
                    │  (external)      │  media snapshot, run logs
                    └──────────────────┘
```

<details>
<summary><b>Where things live</b></summary>

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
| **Scheduled sweeps** — interval maths (pure) + the timer that claims a slot | `src/lib/{schedule,scheduler}.ts` |
| Country flags | `src/lib/flags.ts` |
| REST API | `src/app/api/**` |
| UI (Dracula theme, dark/light/system) | `src/app/**`, `src/components/**`, `src/app/globals.css` |
| DB schema | `prisma/schema.prisma` |

</details>

<details>
<summary><b>External API endpoints used</b></summary>

- **Watchmode (TV):** `/v1/regions/`, `/v1/sources/`, `/v1/search/` (fallback
  only), `/v1/title/{id}/episodes/`, `/v1/title/{id}/sources/` (provider deep
  links, only for shows still missing one), `/v1/changes/titles_episodes_changed/`
  (paid plans; used for change detection), `/v1/status/` (auth via `X-API-Key`),
  plus the public `datasets/title_id_map.csv`.
- **TheMovieDB (movies):** `/3/watch/providers/regions`,
  `/3/watch/providers/movie`, `/3/movie/{id}/watch/providers`
  (auth via the `api_key` query param).
- **Sonarr v3:** `GET /series`, `GET /episode`, `PUT /episode/monitor`,
  `DELETE /episodefile/{id}`, `POST /command` (`EpisodeSearch`).
- **Radarr v3:** `GET /movie`, `PUT /movie/{id}`, `DELETE /moviefile/{id}`,
  `POST /command` (`MoviesSearch`).
- **Seerr (optional):** `GET /api/v1/settings/sonarr`, `.../radarr` to
  auto-discover instances.

</details>

<details>
<summary><b>Dependencies</b></summary>

**Runtime:** `next`, `react`, `react-dom`, `@prisma/client`, `pg`,
`pg-copy-streams`, `swr`, `zod`

**Dev/build:** `prisma`, `typescript`, `@types/*`, `eslint`,
`eslint-config-next`, `vitest`

</details>

---

## 🧪 Development, testing &amp; CI

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server on `:3000` |
| `npm test` | Vitest unit suite — needs no database |
| `npm run test:integration` | Integration suite against a real PostgreSQL (needs `DATABASE_URL`) |
| `npm run test:all` | Both suites |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (`eslint-config-next`, `no-console`) |
| `npm run prisma:migrate` | `prisma migrate deploy` |

### The two suites

**Unit** (`src/**/*.test.ts`) covers the pure decision logic and anything
mockable: `planItem`'s full decision matrix, session tokens, the auth guards,
password hashing, rate limiting, provider matching, the SSRF guard, sweep
scheduling, the concurrency pool, and the Sonarr/Radarr clients' wire format
(fetch-mocked). Fast, and runnable with nothing installed.

**Integration** (`src/**/*.itest.ts`) runs sync, sweep, the run lock and the
admin user routes against a throwaway PostgreSQL, stubbing only the outbound
HTTP. This is where the persistence behaviour is pinned: which titles get
pruned, which lookups are skipped as fresh, that a failing instance does not
abandon the rest of the library, that concurrent sweep requests cannot both
acquire the lock, and that demoting or deleting an account really does end its
sessions.

```bash
createdb streamsweeparr_test
export DATABASE_URL="postgresql://localhost:5432/streamsweeparr_test?schema=public"
npx prisma migrate deploy
npm run test:integration
```

The suite refuses to start without an explicit `DATABASE_URL` — it truncates
tables, so pointing it at a real deployment should take deliberate effort.

GitHub Actions (`.github/workflows/ci.yml`) gates every push/PR on
audit + lint + typecheck + unit tests + integration tests (against a Postgres
service container) + build. Dependency updates arrive via Dependabot
(`.github/dependabot.yml`), grouped weekly. The Docker image is published
(`docker-publish.yml`) only from `main` and version tags.
