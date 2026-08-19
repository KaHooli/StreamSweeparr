<div align="center">

<img src="public/icons/pwa-256x256.png" alt="StreamSweeparr" width="140" />

# StreamSweeparr

**Stop hoarding what you can already stream.**

StreamSweeparr compares your Sonarr &amp; Radarr library against the streaming
services you actually pay for, then unmonitors (and optionally deletes) what's
available there — and puts it back the moment it leaves.

[![CI](https://github.com/KaHooli/StreamSweeparr/actions/workflows/ci.yml/badge.svg)](https://github.com/KaHooli/StreamSweeparr/actions/workflows/ci.yml)
[![Docker image](https://img.shields.io/badge/ghcr.io-streamsweeparr-2496ed?logo=docker&logoColor=white)](https://github.com/KaHooli/StreamSweeparr/pkgs/container/streamsweeparr)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-13%2B-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org)

[Quick start](#-quick-start) ·
[First run](#-first-run-in-five-steps) ·
[Run options](#-every-run-option-in-plain-english) ·
[Troubleshooting](#-troubleshooting) ·
[FAQ](#-faq)

</div>

---

## What it does

You pay for Netflix. Sonarr keeps grabbing shows that are *on* Netflix. Your
disk fills up with things you could have just pressed play on.

StreamSweeparr runs three jobs against your library:

| | | |
|---|---|---|
| 🧹 | **Sweep** | Unmonitors — and optionally deletes — movies and episodes that are already on a streaming service you selected |
| 🔁 | **Re-monitor** | Puts a title back on the list the moment it **leaves** all of your services |
| 🔍 | **Search** | Kicks off a Sonarr/Radarr search for everything still monitored at the end of a run |

It checks availability with **Watchmode** for TV (per-episode data) and, by
default, **TheMovieDB / JustWatch** for movies — or Watchmode for those too, if
you would rather run one provider ([how to
choose](#choosing-who-answers-for-movies)). It gives you a dashboard, a full log of
every run, and two ways to run it without you: [on a
timer](#-scheduled-sweeps), or [the moment a title is
added](#-sweeping-new-titles-as-theyre-added) — Sonarr and Radarr tell it, and
just that one title is swept.

> [!IMPORTANT]
> **Nothing is changed until you say so.** Every run is a **dry-run by default**
> — it only writes down what it *would* do. You turn on LIVE mode when you're
> happy with what you see. And any title tagged **`ss-skip`** in Sonarr/Radarr is
> ignored completely ([details](#-keeping-titles-out-of-the-sweep)).

---

## Contents

**Getting going**
[Before you start](#-before-you-start) ·
[Quick start](#-quick-start) ·
[First run](#-first-run-in-five-steps)

**Using it**
[Day to day](#-using-it-day-to-day) ·
[Run options](#-every-run-option-in-plain-english) ·
[Seasons](#-seasons-follow-their-episodes) ·
[Scheduled sweeps](#-scheduled-sweeps) ·
[Sweep on add](#-sweeping-new-titles-as-theyre-added) ·
[Skipping titles](#-keeping-titles-out-of-the-sweep) ·
[Install as an app](#-install-it-as-an-app)

**When something's wrong**
[Troubleshooting](#-troubleshooting) ·
[System info](#start-at-settings--info) ·
[FAQ](#-faq) ·
[Safety notes](#-safety-notes)

**Configuring &amp; running it properly**
[Accounts &amp; login](#-accounts-login--security) ·
[Environment variables](#-environment-variables) ·
[Behind a reverse proxy](#behind-a-reverse-proxy)

**For the curious**
[How it decides what's "on streaming"](#-how-it-decides-whats-on-streaming) ·
[Who answers for movies](#choosing-who-answers-for-movies) ·
[Keeping API usage low](#-keeping-api-usage-low) ·
[Architecture](#-architecture) ·
[Developing &amp; testing](#-developing--testing)

---

## 📋 Before you start

Gather these first — the setup wizard asks for them in this order:

| | What | Where to get it |
|---|---|---|
| ✅ | **Somewhere to run it** | Docker (easiest), or Node.js 24 |
| ✅ | **A PostgreSQL server, v13+** | Comes with the Docker Compose file below |
| ✅ | **Sonarr and/or Radarr** | v3 or v4 — you need the base URL and API key for each |
| 📺 | **A Watchmode API key** | [api.watchmode.com](https://api.watchmode.com) — *only if you use Sonarr*. You can add several, and they're used in turn |
| 🎬 | **A TheMovieDB API key** | [themoviedb.org](https://www.themoviedb.org) — *only if you use Radarr*, and only while TMDB is answering for movies |
| ⭐ | **A Seerr server** | Optional — lets the app auto-discover your Sonarr/Radarr instances |

> [!TIP]
> You only need the API key for the media types you actually use. TV only?
> Watchmode is enough. Movies only? Just TMDB. Both free tiers are fine —
> see [Keeping API usage low](#-keeping-api-usage-low) for how little the app
> spends.
>
> Movies can be pointed at **Watchmode** instead, in which case you need no TMDB
> key at all — one provider for the whole library, paid for in Watchmode
> credits. See [Choosing who answers for
> movies](#choosing-who-answers-for-movies).

---

## 🚀 Quick start

### The five-minute version (Docker Compose)

No clone required. Make a folder, drop in these two files, and start it.

**`docker-compose.yml`**

```yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: streamsweeparr
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: streamsweeparr
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U streamsweeparr"]
      interval: 5s
      timeout: 5s
      retries: 10

  app:
    image: ghcr.io/kahooli/streamsweeparr:latest
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://streamsweeparr:${POSTGRES_PASSWORD}@db:5432/streamsweeparr?schema=public
      AUTH_SECRET: ${AUTH_SECRET:?set AUTH_SECRET in .env}
      # Plain HTTP on port 3000 — see the note below.
      AUTH_COOKIE_INSECURE: "true"
      # "true" if your Sonarr/Radarr are on a private LAN (10.x / 172.16.x / 192.168.x)
      SSRF_ALLOW_PRIVATE: "false"

volumes:
  pgdata:
```

**`.env`** — generate the secrets, don't invent them:

```bash
echo "AUTH_SECRET=$(openssl rand -hex 32)"        >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"  >> .env
```

Then:

```bash
docker compose up -d
# → http://localhost:3000   (log in as  admin / 0pen0pen&*)
```

The database schema is created and kept up to date automatically on every
start, so upgrading is just `docker compose pull && docker compose up -d`.

> [!WARNING]
> **`AUTH_COOKIE_INSECURE: "true"` is only for plain HTTP.** Login cookies are
> normally marked `Secure`, and browsers throw those away over `http://` — you'd
> sign in and bounce straight back to the login page. If you put the app behind
> HTTPS (please do), delete that line and see
> [Behind a reverse proxy](#behind-a-reverse-proxy).

<details>
<summary><b>Other ways to run it</b> — build from source, or bare Node</summary>

**Build the image yourself** (the repo's own `docker-compose.yml` does this):

```bash
git clone https://github.com/KaHooli/StreamSweeparr.git
cd StreamSweeparr
echo "AUTH_SECRET=$(openssl rand -hex 32)"        >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"  >> .env
docker compose up --build -d
```

That file also publishes Postgres on `127.0.0.1:5432` for local poking, and
binds it to localhost only so it isn't exposed on every interface.

**Already have a Postgres you like?** Remove the `db` service and point
`DATABASE_URL` at your own server.

**No Docker at all** (Node 24 + your own Postgres):

```bash
npm install
cp .env.example .env          # then edit: DATABASE_URL, AUTH_SECRET
npm run prisma:migrate        # create/update the schema
npm run build && npm start    # → http://localhost:3000
```

For development, `npm run dev` instead of the last line.

</details>

<details>
<summary><b>Running on a NAS, Unraid, or a 1–2 vCPU box?</b></summary>

Prisma sizes its database connection pool from the CPU count — a 1-CPU
container gets a pool of just 3, and a page that fires several requests at once
can exhaust it and time out. Append this to your `DATABASE_URL`:

```
?schema=public&connection_limit=10&pool_timeout=20
```

</details>

---

## 🛠 First run, in five steps

Everything below happens in the web UI at `http://localhost:3000`.

### 1. Log in and secure the account

Sign in as **`admin`** / **`0pen0pen&*`**. You'll be forced to set a new
password immediately — that's deliberate, and it's enforced server-side.

Afterwards you can rename the account (or set it from the environment with
`ADMIN_USERNAME` / `ADMIN_PASSWORD`) under **Settings → Users &amp; security**.
Single sign-on and extra user accounts live on that tab too — see
[Accounts, login &amp; security](#-accounts-login--security).

### 2. Add your Watchmode key — *TV, and optionally movies*

**Settings → Watchmode** → paste the key → **Test &amp; save**.

Once a key is saved, **+ Add another key** appears. Add as many as you have (up
to 10): they're numbered, and **every request starts at key 1 and moves to the
next one only when a key is rejected or out of credit**. That pools several free
keys into one budget — useful for the first sync of a large TV library, which is
the only expensive one. **Test &amp; save** reports each key's quota separately,
so you can see which ones still have credit. A key that's already spent is still
worth keeping: it comes back when Watchmode resets your monthly quota.

Below the keys, **Cache lookups for** sets how long an answer is kept before
that title is looked up again — series episodes, provider links, and movies too
if Watchmode is answering those. It defaults to **7 days**, the window a free /
developer key's monthly credit budget is sized for. Shorten it (down to 1 day)
to notice a title arriving on streaming sooner at the cost of more credits;
lengthen it (up to 90 days) to fit a large library into a small budget. On a
paid plan the changes feed already keeps usage near zero and this window is just
its safety net, so a shorter one costs little there. It takes effect on the next
sync, and the run log says which window that sync used.

The first option in the list is **Disabled**, which turns caching off
altogether: every sync looks up every title again — one credit per series, plus
one per movie if Watchmode is answering for movies — and change detection stops
saving anything, because nothing is eligible to be skipped. The card warns you
while it's set. It's there for a paid key with credits to spare, or for the
afternoon you're chasing a snapshot you think has gone stale; it is not a
setting to leave on.

Then pick:
- **Countries** you stream in (alphabetical, with flags), and
- **Streaming services** you subscribe to (alphabetical, with logos), including
  which source types count — subscription, free, rent, buy, TV Everywhere.

### 3. Add your TMDB key — *movies only*

**Settings → Movies** → paste the key → **Test &amp; save**. (That tab is also
where you choose *which* provider answers for movies — TMDB by default, see
[below](#choosing-who-answers-for-movies).)

Then pick your **watch provider regions**, and per region the **movie
providers** you subscribe to, plus which categories count (Subscription / Free /
Ads / Rent / Buy).

#### Choosing who answers for movies

The same tab has one choice above the key: **which provider answers "is this
movie on streaming?"**.

| | Costs | Configured with | Deep links on tiles |
|---|---|---|---|
| **TheMovieDB** *(default)* | nothing — the API is free and unmetered | the regions and providers on the **Movies** tab | no — logos link to a search |
| **Watchmode** | one credit per movie looked up | the countries and services on the **Watchmode** tab | yes — straight to the film |

**TMDB is the default, and it is the right answer for most people.** TV has no
alternative — Watchmode is the only provider with per-episode data — so every
movie TMDB answers for is a Watchmode credit left for the half of your library
that cannot avoid spending them.

Pick **Watchmode** if you'd rather configure one provider than two, or if you
want the provider logos on movie tiles to link straight to the film. A movie is
then re-checked on the **Watchmode cache window** (7 days by default, the same
window as a series) instead of daily, because each lookup costs a credit.

Switching either way takes effect on the next sync, and nothing is thrown away:
your TMDB key, regions and providers stay stored while Watchmode is answering,
and come straight back if you switch back.

### 4. Connect Sonarr &amp; Radarr

**Settings → Connections**. Either:

- configure **Seerr** and hit **Discover instances** to pull them in
  automatically, or
- add each instance by hand — base URL + API key. The app verifies the
  connection before it saves anything.

> On a private LAN? Set `SSRF_ALLOW_PRIVATE=true` or the app will refuse to
> connect. That's the [SSRF guard](#ssrf-protection) doing its job.

### 5. Do a dry run, then go live

**Settings → Run options** — leave **Apply changes (LIVE mode)** **off** for
now. Head to the **Dashboard**, press **Run sweep**, and read the log on the
**Runs** page. It will tell you exactly what it *would* have done, file by file.

Happy with it? Go back over
[the options](#-every-run-option-in-plain-english) — particularly
**Delete files when unmonitoring**, which is **on by default** — then turn on
**Apply changes** and run it again for real. After that, a
[schedule](#-scheduled-sweeps) means you never have to think about it again.

---

## ▶️ Using it day to day

Two buttons on the **Dashboard**:

| Button | What it does |
|---|---|
| **Sync now** | Just refreshes the picture: your library, plus what's currently on streaming |
| **Run sweep** | Syncs, then unmonitors/deletes, re-monitors, tidies Sonarr season flags, and searches |

Both run **in the background** — the page comes straight back and shows live
progress, so a big library never leaves you staring at a spinner. Only one run
happens at a time; if a run dies unexpectedly its lock is reclaimed
automatically.

The **Runs** page keeps the full step-by-step log and the counts for every run
you've ever done, dry-run or live.

Neither button is the only way in. **[Scheduled sweeps](#-scheduled-sweeps)** run
one every so often, and **[sweep on add](#-sweeping-new-titles-as-theyre-added)**
lets Sonarr and Radarr trigger one for a single new title. Both produce the same
runs on the same page.

### What the dashboard shows you

- **TV shows on streaming** — a progress bar per show, counting how many
  episodes are unmonitored out of the total that are on streaming.
- **Movies on streaming** — a **Monitored / Unmonitored** badge per film.
- **Provider logos** under each card link to that title on that service — a
  direct deep link where one exists, otherwise the service's own search for it.
- **Search** narrows both grids as you type — by title, year, or streaming
  service, so "netflix 2019" is a valid thing to ask for. Press <kbd>/</kbd> to
  jump to the box from anywhere on the page, <kbd>Esc</kbd> to clear it. It
  filters what the page already loaded, so there's no round trip and no waiting.
- **The A–Z rails** run down the right edge of the window in a single column,
  top to bottom, on phones as well as desktops. TV shows and movies get an
  alphabet each — marked `TV` and `MOV`, TV above — so a letter always jumps
  within the section you tapped it in. Only letters something starts with are
  shown, and a search narrows the rail along with the grid. Each letter is given
  space in proportion to how much of the page its titles take up, so the rail
  doubles as a map of the scrollbar: where a letter sits in the rail is roughly
  where the page sits when you're reading it. The letter you're currently on is
  highlighted.

<details>
<summary>Where a provider logo takes you</summary>

Every logo links somewhere. Which link you get depends on what's actually
available for that title:

1. **A deep link to the title on that service**, when Watchmode has one.
   Watchmode only returns *per-episode* deep links on paid plans; free plans get
   a placeholder string, which the app discards. So for TV it fetches
   **show-level** links instead, on their own copy of the Watchmode cache
   window and only for shows that are actually missing one — a show doesn't sit
   on second-best links for a week just because its availability is still fresh.
2. **That service's own search page for the title**, when there's no deep link.
   One click further from the title, but still on the service the logo claims
   it's streaming on. This is what movies and free-plan TV shows normally get,
   and the run log tells you how many shows fell back to it.
3. **The TMDB "where to watch" page**, for the handful of services whose search
   URL the app doesn't know. Rather than invent a link into a service, it sends
   you to the page that lists the providers.

Only a title with no TMDB id on a service in that third group ends up with an
unlinked logo.

</details>

---

## ⚙️ Every run option, in plain English

All of these live under **Settings → Run options**.

| Option | Default | What it means |
|---|---|---|
| **Apply changes (LIVE mode)** | ❌ off | The master switch. Off = dry-run: nothing in Sonarr/Radarr is touched, the run just logs what it would do. |
| **Delete files when unmonitoring** | ✅ on | When the sweep unmonitors a title *because it's on streaming*, delete its file too. |
| **Remove files for all unmonitored items** | ❌ off | Wider: at the end of a sweep, delete the file for **every** unmonitored movie/episode, including a back-catalogue you unmonitored by hand years ago. See below. |
| **Remove movies deleted from TMDB** | ✅ on | If TMDB says a movie's id no longer exists, remove it from Radarr. **Files are kept.** |
| **Search monitored items at end of run** | ✅ on | Trigger a Sonarr/Radarr search for everything still monitored once the sweep finishes. |
| **Scheduled sweeps** | ❌ off | Run the sweep on a timer — see [below](#-scheduled-sweeps). |

Every destructive option above is **LIVE-mode only**. In a dry-run they just
print `Would delete …` / `Would remove …`.

> [!NOTE]
> **Delete files when unmonitoring is on out of the box** — which is safe only
> because LIVE mode is off. Before you flip the master switch, decide whether
> you actually want files deleted, or just unmonitored. A dry-run tells you
> exactly which files are in scope.

<details>
<summary><b>"Remove files for all unmonitored items" — read before enabling</b></summary>

**Delete files when unmonitoring** only covers titles the sweep unmonitors *on
that run*. Anything already unmonitored — a back-catalogue you unmonitored by
hand, or titles swept before you turned file deletion on — keeps its files
forever.

This option closes that gap: at the end of a sweep, every movie and episode
still unmonitored has its file deleted. Monitoring itself is never changed,
since those titles are already unmonitored.

It's **off by default** so upgrading can never retroactively wipe your library.
Two things stay out of scope even when it's on:

- titles being **re-monitored** this run — they left streaming, so they end the
  sweep monitored and keep their files, and
- **`ss-skip`** tagged titles, which are never touched.

Note it's a superset of the narrower toggle: with this on, files are removed
from unmonitored titles even if **Delete files when unmonitoring** is off.

</details>

<details>
<summary><b>"Remove movies deleted from TMDB" — what that actually is</b></summary>

This one only applies while **TMDB is answering for movies**, which is the
default. With movies on Watchmode nothing consults TMDB, so no movie is ever
flagged and the option has nothing to act on.

TMDB sometimes deletes or merges entries — usually cancelled or never-produced
films — leaving Radarr holding an id that no longer resolves. Those lookups come
back `404 / status_code 34`.

The app treats that as definitive (transient problems show up as 5xx, 429s or
timeouts, never a 404): the movie is flagged during sync and the sweep removes
it from Radarr. **Media files are kept** and no import exclusion is added, so if
it was wrong you can simply re-add the title. Removals are counted on the
**Runs** page.

</details>

### 📺 Seasons follow their episodes

Sonarr keeps a monitored flag on the **season** as well as on each episode, and
changing episode monitoring leaves it untouched. So a series you already stream
would show every episode unmonitored under a season still marked monitored —
and, more than a cosmetic wrinkle, that flag is what Sonarr gives a **newly
aired episode**, so the season would quietly start collecting them again.

A sweep therefore finishes each Sonarr series by bringing that flag into line
with the episodes underneath it, in both directions:

| The season is marked | When |
|---|---|
| **Unmonitored** | Every episode of it that has **aired** ends up unmonitored |
| **Monitored** | This sweep **re-monitored** an episode in it — the show has left streaming, so the season is wanted again |

- **Only aired episodes count for turning a season off.** A season still airing
  has future episodes monitored on purpose, so that Sonarr grabs them. Waiting
  for those would mean a currently-airing season could never be marked — which
  is the case you hit most, because it's the one Sonarr keeps adding episodes
  to. Those unaired episodes stay monitored, and the run log says so.
- **A season that hasn't started is never touched.** With nothing aired there's
  nothing to go on.
- **Turning a season back on never re-monitors what's still streaming.**
  Episodes that are on one of your services stay unmonitored, which is the
  whole point of the sweep. The run log names how many were held back.
- **A season you unmonitored by hand stays that way** unless the sweep itself
  re-monitors something in it. Nothing changing this run means nothing is
  overridden.
- **Specials (season 0) are never touched** — the sweep doesn't track them.
- **Nothing is deleted by this**, in either direction. It only moves the season
  flag and keeps the episodes underneath where the sweep put them.
- It's **LIVE-mode only**, like everything else — a dry-run prints
  `Would mark season S2 of "…" unmonitored`.

> [!NOTE]
> Sonarr applies a season's monitored flag to **every episode in that season**
> when it changes — there's no way to set one without the other. StreamSweeparr
> puts the affected episodes straight back, so a season change never quietly
> undoes what the sweep just decided. If that repair can't be made (Sonarr goes
> away mid-write) the run ends **FAILED** rather than reporting success, and the
> next sweep settles it.

### ⏱ Scheduled sweeps

**Settings → Run options → Scheduled sweeps** turns **Run sweep** into
something that happens on its own — every **1, 2, 3, 4, 6, 8 or 12 hours**, or
every **1, 2, 3 or 7 days**. The card shows when the next run is due and when
the last one started.

A scheduled sweep *is* the sweep the button runs, so it obeys every other option
— including **Apply changes**. With LIVE mode off, a schedule is simply a
recurring dry-run. Each one shows up on the **Runs** page like any other, opening
with `Starting scheduled … sweep (every 12 hours).`

Things worth knowing:

- **The countdown survives restarts** — the next due time lives in the database,
  not in the process.
- **Turning it on never fires immediately.** The first run is one full interval
  away. Changing the interval re-anchors on the last scheduled run, so
  *shortening* it takes effect straight away.
- **Missed slots are skipped, not replayed.** Down for a day? It runs once when
  it comes back, not once per missed slot.
- **Overlaps are skipped, not queued.** If a sync or sweep is already running,
  the scheduled one steps aside until the next interval.
- **Multiple replicas are safe** — exactly one instance claims each slot. Set
  `SWEEP_SCHEDULER=off` to opt an instance out entirely.

---

## 🪝 Sweeping new titles as they&rsquo;re added

A scheduled sweep runs on the clock. This runs on the *event*: the moment you
add a series in Sonarr or a movie in Radarr, that one title is checked against
your streaming services — and if it&rsquo;s already there, it&rsquo;s unmonitored
before the download client ever picks it up.

Turn it on under **Settings → Run options → Sweep new titles as they&rsquo;re
added**. The card then shows one ready-made URL per connection.

### Setting it up

In **Sonarr** (and again in **Radarr**):

1. **Settings → Connect → `+` → Webhook**
2. **Notification triggers**: tick **On Series Add** only.
   In Radarr it&rsquo;s **On Movie Added**. Leave everything else unticked —
   other triggers are answered with a polite "ignored" and do nothing.
3. **URL**: paste the line for that instance from StreamSweeparr&rsquo;s Settings
   card. It already contains the token and which connection it is:
   `https://sweep.example.com/api/webhook/sonarr?token=…&connection=2`
4. **Method**: POST.
5. Press **Test** — it should come back green. StreamSweeparr answers a test by
   naming the connection it matched, so a green tick means the URL, the token
   *and* the addressing are all right.
6. **Save**.

If you&rsquo;d rather not put the token in the URL, Sonarr&rsquo;s
**Username / Password** fields work too: leave the username as anything and put
the token in the password. An `X-Webhook-Token` header or
`Authorization: Bearer …` is accepted as well.

### What actually happens

A webhook never sweeps on the spot. The title is written to a queue and the
response comes straight back — an *arr that has to wait on a full sweep records
the notification as failed. A worker then picks the queue up:

- **It waits about a minute first.** Sonarr fires *On Series Add* before it has
  fetched the episode list, so sweeping instantly would find nothing to do.
  `WEBHOOK_SWEEP_DELAY_SECONDS` tunes this if your Sonarr is slower than that.
- **A batch becomes one run.** Add eight shows at once and you get one sweep
  covering all eight, not eight runs — and a webhook that fires twice for the
  same title still only sweeps it once.
- **It is the ordinary sweep, just narrowed.** Same options, same decisions,
  same **Apply changes** setting — with every query confined to those titles. It
  costs one Watchmode/TMDB lookup per title rather than a library-wide pass.
- **Nothing is dropped if a run is already going.** The titles simply wait for
  the current sync or sweep to finish.

Each one shows up on the **Runs** page like any other, opening with
`Starting webhook-triggered LIVE sweep for 1 newly added title(s): "…"`.

### Things worth knowing

- **The endpoint is the one part of the app you can reach without signing in** —
  Sonarr has no way to hold a session. It is refused outright while the feature
  is switched off, and otherwise accepts only the token from this card. Rejected
  calls are rate-limited. The token is stored encrypted like every other
  credential, and **Regenerate** invalidates the URLs already pasted into your
  *arr apps, so update them together.
- **Over plain HTTP the token is in the clear.** Fine across a LAN; put the app
  behind TLS if the traffic leaves one.
- **One URL per instance.** With a single Sonarr the `connection=` part is
  optional, but the card always includes it — it&rsquo;s what keeps two Sonarrs
  from being confused for each other.
- **A brand-new series with no episodes yet says so in the run log** and is
  picked up by the next full sweep. If that happens often, raise
  `WEBHOOK_SWEEP_DELAY_SECONDS`.
- **Multiple replicas are safe** — each queued title is claimed by exactly one.
  `SWEEP_SCHEDULER=off` stops an instance running the queue (it still accepts
  webhooks), so leave at least one instance without it.
- **Settings → Info** reports whether it&rsquo;s on and how many titles are
  queued. A number that never falls means nothing is draining the queue.

---

## 🏷 Keeping titles out of the sweep

Tag a series in Sonarr or a movie in Radarr with **`ss-skip`** (case doesn't
matter) and StreamSweeparr leaves it completely alone:

- its streaming availability is **never looked up** — so it costs you no API quota
- its monitored state is **never changed**
- its files are **never deleted**
- it's **excluded from the end-of-run search**

Tagged titles don't appear in the "on streaming" lists either, because the app
deliberately has no availability data for them. Remove the tag and the next sync
picks the title straight back up. The run log reports how many titles were
ignored this way.

This is the right tool for the film you rewatch every Christmas, the show your
streaming service keeps rotating in and out, or anything you simply want to own.

---

## 📱 Install it as an app

StreamSweeparr is a progressive web app, so it can be installed from your
browser and run in its own window with no address bar — handy on a phone, and it
puts the sweep controls on your home screen next to the rest of your *arr stack.

| Platform | How |
|---|---|
| **Desktop Chrome / Edge** | The install icon in the address bar, or ⋮ → *Cast, save and share* → *Install page as app* |
| **Android Chrome** | ⋮ → *Add to Home screen* |
| **iOS Safari** | Share → *Add to Home Screen* |

Installed, it opens standalone in the app's own colours, and long-pressing the
icon offers shortcuts straight to **Dashboard**, **Runs** and **Settings**.

> [!IMPORTANT]
> **Installing requires HTTPS.** Browsers only allow it in a secure context.
> `http://localhost` counts, so testing locally works — but a LAN address over
> plain HTTP does not. Put it behind [a reverse proxy with
> TLS](#behind-a-reverse-proxy).

<details>
<summary><b>What works offline (and what deliberately doesn't)</b></summary>

Everything StreamSweeparr does needs its server, its database and a third-party
API, so an offline mode that "works" would be a lie. What the service worker
does instead is narrow on purpose:

- **Cached:** the app's static build assets, icons, manifest and a small offline
  page. Those bytes are identical for every user.
- **Never cached:** anything under `/api/*`, and every HTML page. This app is
  multi-user and pages are rendered per session — a cached copy of a signed-in
  page (or of the login redirect that replaces it once a session expires) would
  outlive the session that produced it. Redirects are refused by the cache for
  the same reason.

So an unreachable server gets you a proper offline page that reloads itself when
the connection returns, rather than the browser's error page. Signing out leaves
nothing to purge — the worker holds no account data.

</details>

---

## 🔧 Troubleshooting

### Start at Settings → Info

**Settings → Info** is a read-only snapshot of everything you'd otherwise need
an SSH session to find out, and it's the first place to look when something is
off:

- **Application** — version, the commit and time the image was built, Node,
  Next.js and Prisma versions, uptime and memory.
- **Database** — whether PostgreSQL answers and how fast, its version, the host
  and database name, size on disk, connections in use against the server's
  limit, and which migrations have been applied.
- **Library** — how many shows, movies, episodes and title-map rows are stored,
  how many accounts exist, and how the last run finished.
- **Configuration** — LIVE vs dry-run, every run option, which API keys are
  *set* (never their values), how many countries/services/regions/providers are
  selected, connection counts, the sweep schedule, and whether webhook sweeps
  are on (with how many titles are queued).
- **Environment** — `PUBLIC_URL`, `TRUST_PROXY`, `SSRF_ALLOW_PRIVATE`,
  `SYNC_CONCURRENCY`, `LOG_LEVEL` and friends, as the app actually read them.

**Copy diagnostics** puts the whole thing on your clipboard as plain text for a
bug report. It contains no API keys, no passwords, and no database credentials —
`DATABASE_URL` is reduced to host and database name before it ever reaches the
page — so it's safe to paste in public.

The tab is **administrators only**, and so is the endpoint behind it.

| Symptom | Cause | Fix |
|---|---|---|
| **I sign in and get bounced straight back to the login page** | You're on plain HTTP, and browsers drop `Secure` cookies there | Set `AUTH_COOKIE_INSECURE=true`, or serve the app over HTTPS |
| **"Connection failed" when adding Sonarr/Radarr** | They're on a private LAN, which the SSRF guard blocks by default | Set `SSRF_ALLOW_PRIVATE=true` |
| **The app refuses to start** | `AUTH_SECRET` missing or under 16 characters in production | `openssl rand -hex 32` and set it |
| **SSO fails with *"invalid or mismatching redirect_uri"*** | The app is guessing its own address from behind a proxy | Set `PUBLIC_URL` to your real public URL, and register the exact redirect URI shown on the OIDC card |
| **SSO fails with *"Single sign-on failed. Check the server log for details."*** | The detail is deliberately kept out of the URL — the login page is public | Read the app log: the line is tagged `[oidc]` and names the actual cause (a non-HTTPS endpoint, a mismatched issuer or client id, an expired token) |
| **My API keys suddenly read as "not configured"** | `AUTH_SECRET` changed — it's also the encryption key | Restore the old secret, or re-enter the keys. [Details](#-encrypted-credentials) |
| **Pages time out on a small NAS / VM** | Prisma's connection pool is sized from CPU count | Append `&connection_limit=10&pool_timeout=20` to `DATABASE_URL` |
| **No install option in my browser** | Service workers need a secure context | Serve over HTTPS (or test on `localhost`) |
| **A provider logo opens a search page, not the title** | Free Watchmode plans don't include per-episode deep links, and TMDB has none for movies | Working as intended — [what each link is](#what-the-dashboard-shows-you) |
| **A title I want to keep keeps getting swept** | It's genuinely on one of your selected services | Tag it **`ss-skip`** — [how](#-keeping-titles-out-of-the-sweep) |
| **The first sync is slow** | Nothing is cached yet, so every title gets looked up once | Normal. Every sync after that is far cheaper — [why](#-keeping-api-usage-low) |
| **The run log says Watchmode or TMDB is rate limiting requests** | Requests are arriving faster than the provider allows — not the same as running out of credit | The sync paces itself and carries on. If it keeps happening, lengthen the cache window or lower `SYNC_CONCURRENCY` — [detail](#-keeping-api-usage-low) |
| **Sonarr's webhook Test fails with 503** | Webhook sweeps are switched off in StreamSweeparr | Turn on **Settings → Run options → Sweep new titles as they're added** |
| **Sonarr's webhook Test fails with 401** | Wrong or missing token — usually a URL copied before the token was regenerated | Re-copy the URL from the settings card into every *arr |
| **Sonarr's webhook Test fails with 409** | You have several Sonarrs and the URL doesn't say which | Use the per-connection URL from the card; it ends with `&connection=<id>` |
| **Titles are queued but never swept** | Nothing is draining the queue — usually `SWEEP_SCHEDULER=off` on the only instance | Leave at least one instance without it. The queue depth is on **Settings → Info** |
| **A newly added show is swept but nothing happens** | Sonarr hadn't fetched its episode list yet — the run log says so | Raise `WEBHOOK_SWEEP_DELAY_SECONDS`; the next full sweep covers it meanwhile |

Still stuck? Turn up the detail with `LOG_LEVEL=debug`, check the run log on the
**Runs** page — it records every decision the sweep made and why — and include
the **Settings → Info** diagnostics when you report it.

---

## ❓ FAQ

<details>
<summary><b>Will it delete my files the moment I install it?</b></summary>

No. Every run is a dry-run until you enable **Apply changes (LIVE mode)**, and
that switch is off out of the box — so a fresh install can only ever tell you
what it *would* do.

Do check the run options before you flip it, though: **Delete files when
unmonitoring** is on by default, so LIVE mode will delete files for titles it
sweeps unless you turn it off. Read the dry-run log first — it names every file
in scope.

</details>

<details>
<summary><b>What happens when a show leaves Netflix?</b></summary>

The next sweep notices it's no longer on any of your selected services and
**re-monitors** it. If **Search monitored items at end of run** is on, Sonarr or
Radarr goes and gets it again in the same run.

</details>

<details>
<summary><b>Do I need both API keys?</b></summary>

Only for the media types you use — Watchmode for TV (Sonarr), TMDB for movies
(Radarr). If you only run Radarr, you never need a Watchmode key.

And if you'd rather keep one key than two, movies can be pointed at Watchmode as
well, under **Settings → Movies**. TMDB stays the default because it's free, so
using it leaves your Watchmode credits for TV — where there is no alternative.
See [Choosing who answers for movies](#choosing-who-answers-for-movies).

</details>

<details>
<summary><b>Will this burn through my free Watchmode credits?</b></summary>

It's built not to. The metered search endpoint is essentially never used (ids
are resolved from a locally imported map), availability is cached for 7 days by
default — you can set that window yourself under **Settings → Watchmode** — and
on paid plans a changes feed means unchanged shows aren't re-fetched at all.
Movies don't touch that budget at all unless you
[ask them to](#choosing-who-answers-for-movies), and when you do they're cached
for the same window.
And if one key isn't enough for the first pass over a big library, you can save
several — they're used in order, each one taking over when the one before it
runs out. Full detail in [Keeping API usage low](#-keeping-api-usage-low).

</details>

<details>
<summary><b>Can I run more than one instance?</b></summary>

Yes. Scheduled sweeps use a database claim so exactly one instance fires each
slot, webhook-queued titles are claimed the same way, and only one sync/sweep
can run at a time across all of them. Use `SWEEP_SCHEDULER=off` and
`TITLE_MAP_SCHEDULER=off` to make an instance UI-only — but leave at least one
instance without `SWEEP_SCHEDULER=off`, or nothing drains the webhook queue.

</details>

<details>
<summary><b>Do I have to wait for a scheduled sweep after adding a show?</b></summary>

No — turn on **[sweep on add](#-sweeping-new-titles-as-theyre-added)** and point
Sonarr's *On Series Add* (or Radarr's *On Movie Added*) webhook at
StreamSweeparr. About a minute later that one title is swept, so something
already on Netflix is unmonitored before the download client gets to it.

The delay is deliberate: Sonarr fires the webhook before it has fetched the
show's episode list, and a sweep needs that list. `WEBHOOK_SWEEP_DELAY_SECONDS`
adjusts it.

</details>

<details>
<summary><b>Is the webhook endpoint safe to expose?</b></summary>

It is the only route that answers without a session, because Sonarr has no way
to hold one. What guards it: it is **refused outright** unless you have switched
webhook sweeps on, it accepts only the token generated on that settings card
(compared in constant time, stored encrypted at rest), and rejected calls are
rate-limited per client and instance-wide. It never does the sweep inline — it
writes a row and returns — so it cannot be used to tie the app up.

It does not authenticate *which* Sonarr called, only that the caller holds the
token. Anyone with the token can queue a sweep of a title that is already in
your library; they cannot read anything or reach any other endpoint. Over plain
HTTP the token travels in the clear, so put the app behind TLS if the traffic
leaves your LAN.

</details>

<details>
<summary><b>What if Watchmode is down?</b></summary>

Nothing churns. A title whose status can't be determined is flagged *unknown*,
and the sweep will **not** re-monitor it — so an outage can't trigger a mass
re-download.

</details>

<details>
<summary><b>Can other people use it without changing my settings?</b></summary>

Yes — every account is either **admin** (everything) or **user** (read-only
dashboard and run history). SSO users get the `user` role by default.

</details>

<details>
<summary><b>How do I upgrade?</b></summary>

`docker compose pull && docker compose up -d`. Database migrations are applied
automatically on start.

</details>

---

## 🛡 Safety notes

- **Dry-run is the default.** Nothing changes until **Apply changes (LIVE
  mode)** is on.
- **File deletion is permanent.** **Delete files when unmonitoring** is limited
  to titles found on your selected services; **Remove files for all unmonitored
  items** widens that to your whole unmonitored back-catalogue — enable that one
  deliberately.
- **Transient failures never cause churn.** If a title's status can't be
  determined, it's flagged *unknown* and never re-monitored on that basis.
- **API keys are encrypted at rest** and never sent back to the browser — the UI
  only ever sees a "configured" flag. The one exception is the webhook token,
  which is shown to administrators because it is useless until you paste it into
  Sonarr/Radarr. See [Encrypted credentials](#-encrypted-credentials).
- **Sessions are revocable.** Changing a role, changing a password or deleting
  an account ends that account's sessions on its *next* request — not whenever
  the cookie happens to expire.

---

## 🔐 Accounts, login &amp; security

The whole app is behind a login. Unauthenticated page requests are redirected to
`/login`; unauthenticated API calls get a `401`. The single exception is
`/api/webhook/{sonarr,radarr}`, which Sonarr and Radarr call and which
authenticates with its own shared secret instead — it is refused entirely unless
you have switched [sweep on add](#-sweeping-new-titles-as-theyre-added) on.

**Roles.** Every account is either **admin** (settings, connections,
sync/sweep, user management) or **user** (read-only dashboard and run history).
Admin-only routes are enforced on the server, not just hidden in the UI.

### Username &amp; password

There's exactly one local account and it's always an **admin**. It's seeded on
first login as **`admin` / `0pen0pen&*`** and flagged *must change password*,
which is enforced — every route is blocked until you set a new one.

- **Rename it** under **Settings → Users &amp; security → Your account**.
- **Set it from the environment** with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
  While set, these stay authoritative — so the credentials in your compose file
  always work and you always have a way back in. Supplying `ADMIN_PASSWORD`
  also skips the forced password change, since you chose it.
- Passwords are hashed with `scrypt`, sessions are HMAC-signed cookies, and
  login is rate-limited per IP and per IP+username with progressive lockout.

> [!IMPORTANT]
> **`AUTH_SECRET` is required in production.** The app refuses to start without
> at least 16 characters. Generate one with `openssl rand -hex 32` and keep it —
> it also encrypts your stored API keys.

<details>
<summary><b>Single sign-on (OIDC)</b></summary>

Configure it under **Settings → Users &amp; security → Single sign-on (OIDC)** —
issuer plus client id/secret; the endpoints are discovered automatically from
`/.well-known/openid-configuration`. A **Sign in with SSO** button then appears
on the login page.

The flow is Authorization Code + PKCE with `state` validation. Users are
provisioned on first login and can be restricted with an allow-list. **New SSO
users get the `user` role** — an admin promotes them under **Settings → Users
&amp; security → Users**.

The `id_token` that comes back is checked against the issuer you configured,
the client id you configured, and its own expiry, and if your provider also
serves a `userinfo` endpoint the two have to agree on *who* signed in. A token
that fails any of those is refused rather than used.

> [!IMPORTANT]
> **Your OIDC endpoints must be HTTPS.** The issuer (and therefore discovery),
> the token endpoint and the userinfo endpoint are all refused over plain
> `http://`. Your client secret is POSTed to the token endpoint and the identity
> tokens come back on that same connection, so over HTTP anyone on the network
> path can read the secret and rewrite the answer — including who you are. The
> browser-facing authorize URL is not subject to this, since it carries no
> secret.
>
> If your identity provider is currently HTTP-only on your LAN, put it behind a
> TLS terminator before enabling SSO here. `SSRF_ALLOW_PRIVATE` governs whether
> a *private address* may be reached at all; it does not relax this.

> [!WARNING]
> **Redirect URI:** register the *exact* value shown on the OIDC card with your
> provider. Behind a reverse proxy, set **`PUBLIC_URL`** (e.g.
> `https://sweep.example.com`) so the `redirect_uri` matches your public address
> rather than an internal container name. A mismatch here is the usual cause of
> *"invalid or mismatching redirect_uri"*.

**SSO-only mode.** Under **Login options** you can hide the password form
entirely (or set `LOCAL_LOGIN_DISABLED=true`). This is only allowed while OIDC
is enabled *and* fully configured, so you can't lock yourself out — and if SSO
later breaks, `LOCAL_LOGIN_DISABLED=false` forces the password form back on.

Other rails: the instance can never be left without an admin, the local password
account can't be demoted or deleted, and you can't delete your own account.

</details>

### 🔒 Encrypted credentials

Everything that could be used as a credential — the Watchmode, TMDB and Seerr
keys, the OIDC client secret, the webhook token, and every Sonarr/Radarr API key
— is encrypted before it reaches the database. An *arr API key can delete media, so a database
dump or an old backup shouldn't hand that over in the clear.

- **Cipher:** AES-256-GCM, fresh IV per value.
- **Key:** derived from `AUTH_SECRET` via HKDF-SHA256, under a separate `info`
  string from the session-signing key.
- **Scope:** this protects data *at rest*. The running process has to be able to
  decrypt, so anyone who can read the app's environment can derive the key.
  Without a key-management service, that's the honest limit of what a
  self-hosted app can offer.

Password hashes are deliberately **not** encrypted — they're already one-way.

Existing plaintext credentials are converted automatically on the first boot
after upgrading; the step is idempotent and reads accept both forms throughout.

> [!CAUTION]
> **Rotating `AUTH_SECRET` makes stored credentials unrecoverable.** They fail
> to decrypt rather than decrypting to nonsense. When that happens: the affected
> keys read as *not configured* with a banner explaining why, a sync **refuses to
> run** without an API key so nothing destructive happens, and if OIDC was your
> only login method the password form is **automatically re-enabled** so you
> can't be locked out. Restore the old secret, or re-enter the keys in Settings.

### SSRF protection

Every URL you supply — Sonarr/Radarr/Seerr base URLs, OIDC endpoints — is
fetched through a guard that resolves the host first and **always** blocks
loopback, link-local and the `169.254.169.254` cloud-metadata address, with a
request timeout and redirects disabled.

Private LAN ranges are blocked too, unless you set **`SSRF_ALLOW_PRIVATE=true`**
— which you'll need if your *arr apps live on your LAN, as they usually do.

---

## 🔧 Environment variables

Everything else is configured in the UI. See
[`.env.example`](.env.example) for the fully commented version.

**You'll almost certainly set these:**

| Variable | Required | What it's for |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `AUTH_SECRET` | ✅ (prod) | Signs sessions **and** encrypts stored API keys. ≥16 chars — `openssl rand -hex 32` |
| `SSRF_ALLOW_PRIVATE` | — | `true` to allow private LAN ranges — needed for LAN *arr apps |
| `AUTH_COOKIE_INSECURE` | — | `true` when serving over plain HTTP, or login silently fails |

**Behind a proxy or using SSO:**

| Variable | What it's for |
|---|---|
| `PUBLIC_URL` | Your public origin — fixes the OIDC `redirect_uri` |
| `TRUST_PROXY` | `true` to believe `X-Forwarded-For/Proto/Host` — only behind a proxy you control |
| `OIDC_REDIRECT_URI` | Override the OIDC callback outright (rarely needed) |
| `LOCAL_LOGIN_DISABLED` | `true` hides the password form (SSO-only); `false` forces it back on |

**Accounts and tuning:**

| Variable | What it's for |
|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Seed **and** keep authoritative the local admin account |
| `SYNC_CONCURRENCY` | Titles looked up in parallel during a sync (default `4`, max `32`) |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` for background work (default `info`) |
| `SWEEP_SCHEDULER` | `off` stops *this instance* running scheduled **and** webhook sweeps |
| `WEBHOOK_SWEEP_DELAY_SECONDS` | How long a webhook-queued title settles before its sweep (default `60`, max `3600`) |
| `TITLE_MAP_SCHEDULER` | `off` disables the 12h Title ID map refresh on this instance |
| `PORT` | Port for `next start` (default `3000`) |

### Behind a reverse proxy

Put the app behind TLS and set **both**:

```
PUBLIC_URL=https://sweep.example.com
TRUST_PROXY=true
```

…and remove `AUTH_COOKIE_INSECURE`, since you're on HTTPS now.

<details>
<summary>Why <code>TRUST_PROXY</code> is off by default</summary>

`X-Forwarded-*` headers only mean anything when something you control
overwrites them. If the app is reachable directly, any client can forge them —
and since the login rate limiter buckets by client IP, a forged header would let
an attacker pick a fresh bucket for every attempt.

With it off, per-IP throttling collapses into one bucket, but the per-username
and instance-wide limiters still apply, so brute force is still bounded.

</details>

---

## 🧮 How it decides what's "on streaming"

Split by media type, and each provider is configured on its own Settings tab.
They all work the same way: a title counts as *on streaming* only if the service
is one **you selected** *and* the way it's offered is a **type you count**.

| | Provider | Counts if… | "On streaming" means |
|---|---|---|---|
| 📺 | **TV — Watchmode** | the source is one of your selected services, and its type (`sub`, `free`, `purchase`, `rent`, `tv_everywhere`) is one you count | **≥1 episode** matches |
| 🎬 | **Movies — TMDB** *(default)* | the provider is one of your selected ones for that region, and the category (`flatrate`, `free`, `ads`, `rent`, `buy`) is one you count | **≥1 match** |
| 🎬 | **Movies — Watchmode** *(optional)* | exactly the TV rule, against the same countries, services and source types you picked for TV | **≥1 match** |

This is why the source-type checkboxes matter: leave *Rent* and *Buy*
unchecked and a film that's only purchasable won't be treated as something you
can already stream.

---

## 💳 Keeping API usage low

TV availability is the only per-title Watchmode cost, and three layers keep it
small:

1. **A local Title ID map** resolves TMDB/IMDB → Watchmode ids for free, so the
   metered `/search` endpoint is essentially never used.
2. **Change detection (paid plans).** Each sync asks which titles changed since
   last time — a few calls total, regardless of library size — and everything
   unchanged reuses its cached availability. On a settled library that takes
   ongoing usage from *one call per series* to *near zero*. The app **detects
   your plan automatically** (cached, re-checked weekly), so a free key never
   makes a failing call; the result is shown under **Settings → Watchmode**.
3. **A freshness window you set.** Independent of the above, a series pulled
   within the window isn't pulled again — the safety net when the changes feed
   isn't available, and the *only* rationing there is on a free / developer key,
   which has no changes feed. **Settings → Watchmode → Cache lookups for**,
   default **7 days**, anywhere from 1 to 90 — or **Disabled**, which switches
   this layer off and, with it, any benefit from layer 2: every title is looked
   up on every sync.

A LIVE sweep also **doesn't re-sync afterwards** — the snapshot is updated in
place as changes are applied. The run log reports how many episode fetches were
made versus skipped.

The first sync after setup still pulls every series once, because nothing is
cached yet. Every sync after that is cheap. If that first sync is bigger than a
single free key's monthly credit, add more keys under **Settings → Watchmode** —
a run that exhausts key 1 carries on with key 2 rather than stopping half way,
and the run log says when it switched.

**Movies (TMDB)** get the same treatment on a shorter clock: TMDB has no changes
feed, so a movie looked up successfully in the last **24 hours** is served from
cache. On a 12-hourly schedule that halves TMDB traffic. Anything whose lookup
failed — or that just had its `ss-skip` tag removed — is always re-checked.

**Movies on Watchmode** — if you [chose that](#choosing-who-answers-for-movies) —
are held for the **Watchmode cache window** instead (7 days by default), the same
window as a series. What makes the 24-hour window affordable is that TMDB calls
are free; every Watchmode call spends a credit, so a daily re-check would cost
more per film than a whole TV library costs per week. Each movie also keeps the Watchmode id it resolved to,
so the metered search endpoint stays out of steady-state syncs, and an install
that uses Watchmode for *movies only* never probes for the Changes API — the
feed is episode-shaped, so there would be nothing to do with the answer.

Sync also looks titles up **in parallel** (`SYNC_CONCURRENCY`, default 4), which
is what turns a large library's sync from minutes of waiting into something much
shorter.

**If Watchmode rate limits you, the sync slows down rather than giving up.**
Being rate limited (HTTP 429) is Watchmode saying the requests are arriving too
quickly — it is not the same as running out of credit, and it can happen on a
free key with the whole monthly budget still unspent, typically when the cache
window is **Disabled** so every title is looked up again. The app waits out the
pause Watchmode asks for, retries the same key, and then keeps a gap between
requests for the rest of that sync, widening it if it happens again. The run log
says so once, when the pacing changes. Your keys are left alone — only a key
that is *rejected* (invalid, or out of credit) is set aside. If you see it
often, lengthen the cache window or lower `SYNC_CONCURRENCY`.

**TMDB is treated the same way**, for a different reason: its calls are free, so
a 429 there costs nothing but the answer — and a movie given up on is recorded
as unknown for that sync, which means it is neither unmonitored nor
re-monitored. It too is retried and then paced, and the run log says so.

**[Sweeping on add](#-sweeping-new-titles-as-theyre-added) is the cheapest run
there is.** It looks at only the titles Sonarr/Radarr just told it about, so it
costs one lookup per new title rather than a pass over the library — and it
deliberately ignores the freshness windows above, because it is running
*because* that title just changed. It skips the changes feed entirely.

<details>
<summary><b>The Title ID map, in detail</b></summary>

The Watchmode API is keyed on **Watchmode ids**, so every title from
Sonarr/Radarr has to be converted from its TMDB/IMDB id first. Rather than spend
Watchmode *search* quota on every title, the app imports Watchmode's daily
[`title_id_map.csv`](https://api.watchmode.com/datasets/title_id_map.csv) and
resolves ids locally.

The refresh runs at the start of every sync and on a 12-hour timer:

1. **First run** → skip the ETag check.
2. Otherwise `HEAD` the CSV; if the **ETag** matches the last import, stop.
3. Download it, recording **Last-Modified** + **ETag** for next time.
4. `TRUNCATE` the table, then stream-import via the Postgres `COPY` protocol —
   which works against any external Postgres.
5. Repeat at most every 12 hours.

Lookups try this map first and only fall back to Watchmode's `/search` when a
title is missing from the CSV. You can check status and force a refresh under
**Settings → Watchmode → Title ID map**, or via `POST /api/titlemap`
(`{ "force": true }` to bypass the window and ETag). `TITLE_MAP_SCHEDULER=off`
disables the timer on an instance.

To force a full re-pull of availability — e.g. after changing your selected
countries or services — clear `watchmodeChangesCursor` and `providerSyncedAt`.

</details>

---

## 🏗 Architecture

```
                          ┌──────────────────────────────┐
   Browser (Dracula UI) ──►  Next.js 16 App Router        │
   dashboard / settings    │  ├─ React Server + Client    │
   / runs                  │  └─ API routes (/api/*)      │
                           └──────┬───────────────┬───────┘
                                  │               │
                    ┌─────────────▼───┐   ┌───────▼────────────┐
                    │ Business logic  │   │ External APIs      │
                    │  lib/sync.ts    │   │  Watchmode         │
                    │  lib/sweep.ts   │◄──┤  TheMovieDB        │
                    │  lib/watchmode  │   │  Sonarr v3         │
                    │  lib/arr        │   │  Radarr v3         │
                    └────────┬────────┘   │  Seerr (discovery) │
                             │ Prisma     └────────────────────┘
                    ┌────────▼─────────┐
                    │  PostgreSQL      │  settings, connections, media
                    │  (external)      │  snapshot, run logs, sweep queue
                    └──────────────────┘
```

Traffic runs the other way too: Sonarr and Radarr POST to `/api/webhook/*` when
a title is added, which queues it for a sweep of its own — the only inbound path
that does not carry a session.


<details>
<summary><b>Where things live</b></summary>

| Concern | File(s) |
|---|---|
| DB client + settings bootstrap | `src/lib/db.ts` |
| Auth: sessions / passwords / users / OIDC | `src/lib/{session,password,users,oidc}.ts` |
| Route protection (edge proxy) | `src/proxy.ts` |
| Auth API (login, logout, session, change-password, OIDC) | `src/app/api/auth/**` |
| Login page | `src/app/login/page.tsx` |
| Watchmode client (regions, sources, title lookup, availability) | `src/lib/watchmode.ts` |
| TMDB client (regions, providers, availability) | `src/lib/tmdb.ts` |
| Sonarr / Radarr / Seerr clients | `src/lib/arr.ts` |
| **Title ID map** — TMDB/IMDB → Watchmode id, imported from Watchmode's daily CSV | `src/lib/titlemap.ts` |
| 12h scheduler for the Title ID map | `src/instrumentation.ts` |
| **Sync engine** — snapshot library + streaming availability into Postgres | `src/lib/sync.ts` |
| **Sweep engine** — unmonitor/delete, re-monitor, search | `src/lib/sweep.ts` |
| **Scheduled sweeps** — interval maths (pure) + the timer that claims a slot | `src/lib/{schedule,scheduler}.ts` |
| **Webhook sweeps** — payload parsing + shared secret, the URLs the UI hands out, the queue and its worker | `src/lib/{webhook,webhookUrl,sweepQueue}.ts`, `src/app/api/webhook/[arr]/route.ts` |
| Background run lock + live progress | `src/lib/jobs.ts` |
| Whether setup is complete, per media type | `src/lib/setupState.ts` |
| SSRF-guarded fetch | `src/lib/safeFetch.ts` |
| Credential encryption at rest | `src/lib/secrets.ts` |
| Country flags | `src/lib/flags.ts` |
| REST API | `src/app/api/**` |
| UI (Dracula theme, dark/light/system) | `src/app/**`, `src/components/**`, `src/app/globals.css` |
| PWA: manifest, service worker, offline fallback | `public/{manifest.webmanifest,sw.js,offline.html}`, `src/components/ServiceWorkerRegistrar.tsx` |
| DB schema | `prisma/schema.prisma` |

</details>

<details>
<summary><b>External API endpoints used</b></summary>

- **Watchmode (TV, and movies if you selected it):** `/v1/regions/`,
  `/v1/sources/`, `/v1/search/` (fallback only), `/v1/title/{id}/episodes/`,
  `/v1/title/{id}/sources/` (provider deep links for shows still missing one —
  and the whole answer for a movie), `/v1/changes/titles_episodes_changed/`
  (paid plans; used for change detection), `/v1/status/` (auth via `X-API-Key`),
  plus the public `datasets/title_id_map.csv`.
- **TheMovieDB (movies, by default):** `/3/watch/providers/regions`,
  `/3/watch/providers/movie`, `/3/movie/{id}/watch/providers`
  (auth via the `api_key` query param).
- **Sonarr v3:** `GET /series`, `GET /series/{id}` (webhook sweeps),
  `GET /episode`, `PUT /episode/monitor`, `DELETE /episodefile/{id}`,
  `POST /command` (`EpisodeSearch`).
- **Radarr v3:** `GET /movie`, `GET /movie/{id}`, `PUT /movie/{id}`,
  `DELETE /moviefile/{id}`, `POST /command` (`MoviesSearch`).
- **Seerr (optional):** `GET /api/v1/settings/sonarr`, `.../radarr` to
  auto-discover instances.

</details>

<details>
<summary><b>Dependencies</b></summary>

**Runtime:** `next`, `react`, `react-dom`, `@prisma/client`, `pg`,
`pg-copy-streams`, `swr`, `zod`

**Dev/build:** `prisma`, `typescript`, `@types/*`, `eslint`,
`eslint-config-next`, `vitest`, `@testing-library/react`, `jsdom`

</details>

---

## 🧪 Developing &amp; testing

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server on `:3000` |
| `npm test` | Unit suite — needs no database |
| `npm run test:integration` | Integration suite against a real PostgreSQL (needs `DATABASE_URL`) |
| `npm run test:all` | Both suites |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (`eslint-config-next` + `no-console`) |
| `npm run prisma:migrate` | `prisma migrate deploy` |

<details>
<summary><b>The two test suites</b></summary>

**Unit** (`src/**/*.test.{ts,tsx}`) covers the pure decision logic and anything
mockable: `planItem`'s full decision matrix, session tokens, the auth guards,
password hashing, rate limiting, provider matching, credential encryption, the
SSRF guard, sweep scheduling, the concurrency pool, and the Sonarr/Radarr
clients' wire format (fetch-mocked). Fast, and runnable with nothing installed.

`src/test/sw.test.ts` is the odd one out: it loads the shipped `public/sw.js`
and drives its event handlers against a stand-in service worker scope, because
the rules that matter there are about what must *never* end up in the cache.

Component tests use React Testing Library and opt into a DOM per file with a
`// @vitest-environment jsdom` docblock — the default environment stays `node`
so the mostly-pure suite doesn't pay for a DOM it never touches.

**Integration** (`src/**/*.itest.ts`) runs sync, sweep, the run lock and the
admin user routes against a throwaway PostgreSQL, stubbing only the outbound
HTTP. This is where persistence behaviour is pinned: which titles get pruned,
which lookups are skipped as fresh, that a failing instance doesn't abandon the
rest of the library, that concurrent sweep requests can't both acquire the lock,
and that demoting or deleting an account really does end its sessions.

```bash
createdb streamsweeparr_test
export DATABASE_URL="postgresql://localhost:5432/streamsweeparr_test?schema=public"
npx prisma migrate deploy
npm run test:integration
```

The suite refuses to start without an explicit `DATABASE_URL` — it truncates
tables, so pointing it at a real deployment should take deliberate effort.

</details>

CI (`.github/workflows/ci.yml`) gates every push and PR on audit + lint +
typecheck + unit tests + integration tests (against a Postgres service
container) + build. Dependency updates arrive via Dependabot, grouped weekly.
The Docker image is published from `main` and version tags only.
