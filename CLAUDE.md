# CLAUDE.md

Guidance for AI assistants working in this repository.

`README.md` is the user-facing manual — how to install it, what every setting
does, how availability is decided. It is long and it is kept current; read the
relevant section before changing behaviour it describes, and update it when you
change that behaviour. This file covers the things a contributor needs that the
README deliberately leaves out.

---

## What this is

StreamSweeparr is a self-hosted Next.js app that keeps a Sonarr/Radarr library
in step with what is already available on the streaming services you pay for:

- **Sync** snapshots the library from every Sonarr/Radarr instance and enriches
  it with streaming availability — **Watchmode for TV** (per-episode) and, by
  default, **TheMovieDB for movies** (JustWatch-backed watch providers).
  `Settings.movieProvider` can point movies at Watchmode's title-level sources
  endpoint instead; TV has no such choice. TMDB is the default because it is
  free, so it leaves the metered Watchmode budget to the half of the library
  that cannot avoid it — see `MovieLookup` in `lib/sync.ts`, chosen once in
  `runSync` and handed to `syncRadarr`.
- **Sweep** acts on that snapshot: unmonitor (and optionally delete) what is on
  streaming, re-monitor what has left streaming, optionally purge files for
  everything still unmonitored, then trigger a search for what remains
  monitored.

A sweep starts three ways — the button, the schedule (`lib/scheduler.ts`), or a
Sonarr/Radarr webhook saying a title was just added (`lib/sweepQueue.ts`). The
third is the same sweep with every query narrowed to those titles, not a
separate code path; `runTargetedSweep` in `lib/sweep.ts` is the entry point.

Sweeps are destructive by design, so `applyChanges` defaults to **false** — a
run is a dry-run until an admin explicitly enables LIVE mode. That applies to
all three triggers equally.

Single-tenant: `Settings` is one row, always `id = 1`.

---

## Stack

| | |
|---|---|
| Framework | Next.js 16 (App Router), React 19 |
| Language | TypeScript, `strict: true` |
| Database | PostgreSQL via Prisma 7 on the `@prisma/adapter-pg` driver adapter, plus raw `pg` for `COPY` |
| Validation | zod |
| Client data | SWR |
| Tests | Vitest (+ React Testing Library, jsdom) |
| Lint | ESLint 9 flat config, `eslint-config-next` |
| Node | **24** — pinned in `.nvmrc` and enforced everywhere (see below) |
| Styling | one hand-written global stylesheet, `src/app/globals.css` |

No Tailwind, no CSS modules, no component library, no state manager.

---

## Commands

```bash
npm run dev                # Next dev server on :3000 (needs DATABASE_URL)
npm run build              # prisma generate && next build
npm start                  # production server

npm run lint               # ESLint
npm run typecheck          # tsc --noEmit
npm test                   # unit suite — no database, no network
npm run test:integration   # integration suite — needs a throwaway DATABASE_URL
npm run test:all           # both suites
npm run check:node         # assert .nvmrc / Dockerfile / engines / CI agree

npm run prisma:generate    # prisma generate
npm run prisma:migrate     # prisma migrate deploy
npm run prisma:push        # prisma db push (local scratch only)
```

**Before proposing a change as finished, run: `npm run lint && npm run typecheck
&& npm test`.** Add `npm run test:integration` when you touch `lib/sync.ts`,
`lib/sweep.ts`, `lib/jobs.ts`, `lib/secrets.ts`, `lib/sweepQueue.ts`, the users
API, the webhook route, or anything that writes to Postgres.

Integration tests need a real database and **refuse to start without an explicit
`DATABASE_URL`** (they `TRUNCATE`, so pointing them at a live deployment has to
be deliberate):

```bash
createdb streamsweeparr_test
export DATABASE_URL="postgresql://localhost:5432/streamsweeparr_test?schema=public"
npx prisma migrate deploy
npm run test:integration
```

---

## Layout

```
prisma.config.ts           # Prisma 7 CLI config: schema path, migrations, datasource
prisma/
  schema.prisma            # single source of truth for the data model
  migrations/              # hand-written SQL, applied with `migrate deploy`
scripts/
  check-node-version.mjs   # dependency-free; runs before `npm ci` in CI
src/
  generated/prisma/        # GENERATED client — gitignored, never edited, never imported from by path
  proxy.ts                 # EDGE auth gate (Next 16's renamed middleware)
  instrumentation.ts       # boot hook: secret assertion, at-rest migration, timers
  app/
    layout.tsx             # metadata, theme no-flash script, Nav, SW registrar
    page.tsx               # dashboard (server component)
    runs/  settings/  login/  change-password/
    api/**/route.ts        # the REST surface
    globals.css            # the entire stylesheet (~1100 lines)
  components/
    settings/              # one card per slice of configuration
  lib/                     # all business logic
  test/                    # integration setup + shared DB fixtures
  types/                   # ambient declarations
```

### Where the logic lives

| Concern | File |
|---|---|
| Prisma client + settings bootstrap + decryption | `lib/db.ts` |
| `DATABASE_URL` → pg adapter options (pool size, wait, schema) | `lib/dbConfig.ts` |
| Sync engine (library + availability → Postgres) | `lib/sync.ts` |
| Sweep engine (unmonitor / delete / re-monitor / search) | `lib/sweep.ts` |
| Run lock, heartbeat, progress log | `lib/jobs.ts` |
| Watchmode client + key-ring failover | `lib/watchmode.ts`, `lib/watchmodeKeys.ts` |
| TMDB client | `lib/tmdb.ts` |
| Sonarr / Radarr / Seerr clients | `lib/arr.ts` |
| Title ID map (TMDB/IMDB → Watchmode, CSV import) | `lib/titlemap.ts` |
| Scheduled sweeps: pure interval maths / the timer | `lib/schedule.ts`, `lib/scheduler.ts` |
| Webhook sweeps: payload parsing + shared secret / the URLs the UI builds | `lib/webhook.ts`, `lib/webhookUrl.ts` |
| Webhook sweep queue: enqueue, claim, drain, the worker | `lib/sweepQueue.ts` |
| Sessions (edge-safe HMAC) | `lib/session.ts` |
| Route guards (Node, database-backed) | `lib/auth.ts` |
| Credential encryption at rest | `lib/secrets.ts` |
| SSRF-guarded fetch | `lib/safeFetch.ts` |
| Users, passwords, OIDC | `lib/users.ts`, `lib/password.ts`, `lib/oidc.ts` |
| Dashboard query + shapes | `lib/dashboard.ts` |
| "Is this install configured yet?" (per media type) | `lib/setupState.ts` |
| Client fetch helpers + `ApiError` | `lib/fetcher.ts` |

Import with the `@/` alias (`@/lib/db`), which maps to `src/`. Modules *within*
`lib/` import each other relatively (`./db`), as do the cards within
`components/settings/`; everything crossing a directory — including the test
files — uses `@/`. Match whichever file you are editing.

---

## Conventions that matter

### 1. Comments explain *why*, at length

This codebase has an unusually strong comment culture and it is deliberate.
Most non-trivial functions carry a docblock that explains the reasoning, the
alternative that was rejected, and often the bug that motivated the current
shape — see `lib/jobs.ts` (`RunContext.finish`), `lib/useSyncedState.ts`, or
`.github/dependabot.yml`. **Match this.** A change that fixes a subtle bug
should leave behind a comment saying what went wrong, not just the fix. Do not
strip existing explanatory comments to "tidy up".

Comments describe the code as it stands. They do not narrate the edit ("changed
this to…"), and they do not reference PRs or agents.

### 2. `no-console` is an error

All server-side logging goes through `lib/logger.ts`:

```ts
import { logger } from "./logger";
const log = logger("sweep");   // → "[info] [sweep] …"
```

The only sanctioned `console` calls are inside `logger.ts` itself, one
documented edge-runtime exception in `session.ts`, and `scripts/*.mjs` (which
run before anything is installed). `public/` is excluded from linting.

### 3. The edge / Node split is load-bearing

`src/proxy.ts` runs on the **edge runtime**. Anything it imports — transitively
— must be free of Node built-ins. That is why `lib/session.ts` uses Web Crypto
(`crypto.subtle`) rather than `node:crypto`, and why `instrumentation.ts` uses
dynamic `await import()` for everything Node-only.

Never import `lib/safeFetch.ts` (`node:dns`, `node:net`), `lib/secrets.ts` or
`lib/webhook.ts` (both `node:crypto`), or `lib/db.ts` from anything reachable by
the proxy. `proxy.ts` therefore spells out the webhook paths itself rather than
importing them — if you add a public path, keep that list and `lib/webhookUrl.ts`
in step by hand.

The same split runs the other way, for **client** components. `lib/webhook.ts`
is server-only, so the URL-building half it shares with the settings card lives
in `lib/webhookUrl.ts`, which has no Node imports and is safe in the browser.
When a client component needs logic that currently sits in a Node-only module,
split the isomorphic part out like this rather than duplicating it.

### 4. Two layers of auth, with distinct jobs

- **`src/proxy.ts` (edge)** checks the cookie *signature* only. It turns
  anonymous traffic away, redirects pages to `/login?next=…`, returns 401 JSON
  for `/api/*`, and enforces the mandatory-password-change flow. It has no
  database, so it cannot know whether the account still exists.
- **`lib/auth.ts` (Node)** is the authority. `requireSession()` /
  `requireAdmin()` re-read the user, reject tokens whose `ver` is behind the
  account's `tokenVersion`, and report the role **as stored now**.

Every API route handler is wrapped:

```ts
export const dynamic = "force-dynamic";

export const POST = withGuard(requireAdmin, async (session, req: NextRequest) => {
  // ...
  return NextResponse.json({ ok: true });
});
```

`withGuard` translates `AuthError` into the right JSON status. **A new route
gets a guard.** There are exactly three exceptions, and all three are listed as
public in `proxy.ts` too:

- `/api/health` — public probe, deliberately thin so it is not a recon surface.
- `/api/auth/*` — must work before a session exists.
- `/api/webhook/{sonarr,radarr}` — Sonarr and Radarr have no way to hold a
  session, so this one authenticates *itself* rather than being unauthenticated:
  it is refused with 503 unless `webhookEnabled` is set, then compares the
  caller's token against `Settings.webhookToken` in constant time, and
  rate-limits rejected calls. It queues and returns; it never sweeps inline.
  See `lib/webhook.ts`.

Do not add a fourth without the same treatment — a route outside the session
gate needs its own credential, its own kill switch, and its own rate limit.

Bump `tokenVersion` whenever a session must stop being honoured (role change,
password change, admin revocation).

### 5. Credentials are encrypted at rest, and `getSettings()` hides it

Watchmode/TMDB/Seerr keys, the OIDC client secret, the webhook token, and every
Sonarr/Radarr API key are stored as `enc:v1:<base64url>` (AES-256-GCM, key
derived from `AUTH_SECRET` via HKDF).

- Read config through **`getSettings()`** — it returns decrypted values and
  normalises the Watchmode key ring.
- `getRawSettings()` returns the stored (still-encrypted) form. Only the
  boot-time migration and the settings API's "present but unreadable" check
  should use it.
- Writes go through `encryptSettingsData()` / the connection helpers in
  `lib/secrets.ts`.
- **Secrets never reach the browser.** The settings API returns booleans
  (`tmdbApiKeySet`) and counts (`watchmodeApiKeyCount`), and the UI refers to an
  untouched stored key *by position*. Keep it that way.
- **One deliberate exception: `webhookToken`.** It is returned in full, because
  it has no use until the admin pastes it into Sonarr/Radarr and a masked value
  cannot be pasted. That is the bar for an exception — the credential is
  *outbound*, the endpoint returning it is `requireAdmin`, and the value is
  still encrypted at rest. A credential the app uses on the user's behalf never
  qualifies.
- `secretsUnreadable` distinguishes "never configured" from "`AUTH_SECRET`
  changed, so this can no longer be decrypted". Do not collapse the two.

### 6. Every outbound request to a user-supplied URL uses `safeFetch`

Sonarr, Radarr, Seerr and OIDC endpoints are all user-entered. `safeFetch`
DNS-resolves the host and blocks loopback, link-local (incl. `169.254.169.254`),
multicast and broadcast **always**; private LAN ranges are blocked unless
`SSRF_ALLOW_PRIVATE=true`. It also enforces a timeout. Watchmode and TMDB have
fixed hosts and use plain `fetch`.

### 7. Runs are singular, detached and audited

`startRun()` in `lib/jobs.ts` is the only way to begin a sync or sweep. It:

- takes a **transaction-scoped Postgres advisory lock** around the
  reap-check-create sequence, so two simultaneous requests cannot both start;
- reaps `RUNNING` rows whose heartbeat is older than 5 minutes;
- creates the `RunLog` row, returns its id **immediately**, and executes the
  body detached. Clients poll `GET /api/runs/{id}`.

`RunContext` buffers log lines and flushes them with counts + heartbeat on a
throttle. Writes are serialised through a promise chain and `finish()` goes
through that same chain — issuing the terminal write independently caused a
real, intermittent bug where a late progress write reset the counts on a run
already marked SUCCESS. Do not "simplify" that away.

A sweep never abandons the library on one failure: per-item errors are collected
by `ErrorCollector` and the run ends `FAILED` with a summary, so a partial sweep
is never mistaken for a clean one.

Because only one run may be active, **anything that wants to start a sweep on an
external event has to queue, not call `startRun` and hope.** That is what
`QueuedSweep` + `lib/sweepQueue.ts` are for: the webhook endpoint records the
title and returns, and a worker turns whatever has settled into one targeted
run. `runTargetedSweep`'s `onFinished` is how a caller learns the outcome of a
body that is otherwise detached — the queue uses it to drop the titles it handed
over, or to put them back.

### 8. Destructive-by-default is guarded

Anything that deletes or mutates Sonarr/Radarr must respect:

- `applyChanges` — false means dry-run; log what *would* happen, mutate nothing.
- `streamingUnknown` — a failed/unmapped lookup. **Never** re-monitor or
  unmonitor on unknown status; a Watchmode outage must not churn the library.
- `skipped` — the `ss-skip` tag (`SKIP_TAG_LABEL` in `lib/arr.ts`). Skipped
  titles are never looked up, never (un)monitored, never have files deleted, and
  are excluded from the end-of-run search.
- `purgeUnmonitoredFiles` is broader than `deleteFiles` and off by default.

`planItem()` in `lib/sweep.ts` is the pure decision function for all of this,
and `sweep.test.ts` pins its full matrix. Change the rules there and update the
matrix in the same commit.

### 9. API-usage frugality is a feature

Watchmode credits are the scarce resource. Three mechanisms keep usage down and
all three must survive your change: the local **Title ID map** (avoids the
metered `/search`), **change detection** on paid plans
(`watchmodeChangesCursor`, with automatic plan probing), and freshness windows
(`providerSyncedAt`, 7 days for TV; 24 hours for TMDB movies). A LIVE sweep also
updates the snapshot in place rather than re-syncing afterwards.

A movie answered by Watchmode keeps the **7-day** TV window rather than the
24-hour TMDB one (`WATCHMODE_MOVIE_TTL_MS`): what makes a daily re-check
affordable is that TMDB calls are free. For the same reason an install using
Watchmode for movies *only* skips the plan probe — the changes feed is
episode-shaped, so the answer could not be used.

A **scoped** sync (`runSync(progress, { targets, force })`) is the cheap path
and the one deliberate exception: it looks at only the named titles, and `force`
bypasses the freshness windows because a webhook sweep runs *because* those
titles just changed. It also skips the changes feed and must never advance
`watchmodeChangesCursor` — moving the cursor after looking at three series would
mark every other change in the feed as seen. For the same reason it does not
prune: a pass that never saw the rest of the library cannot conclude it is gone.

If you add a provider call, say in its docblock what bounds how often it runs.

### 10. Data model rules

- `Settings` is a singleton, `id = 1`. `getSettings()` creates it on demand and
  treats a `P2002` race as success — several parallel requests hit this on a
  fresh database.
- `watchmodeApiKeys` (array) is the source of truth for the key ring;
  `watchmodeApiKey` is a derived mirror of the first element kept for older code
  paths. Write both consistently.
- `QueuedSweep` is a work queue, not a log: rows are deleted once their sweep
  finishes. Its unique key `(connectionId, mediaType, arrId)` is what collapses a
  webhook that fires twice into one sweep, and `claimedBy` is what makes a claim
  exclusive between replicas. Do not relax either.
- Indexes exist for specific queries and the schema says which (dashboard
  filtering, sync's prune-by-timestamp, the end-of-run episode scan, the queue's
  oldest-unclaimed scan). Keep the comment truthful if you change a query shape.

### 11. The Prisma client is generated into the source tree

Prisma 7 removed the Rust query engine, and three things follow from that.

- **The client is not in `node_modules`.** It is generated into
  `src/generated/prisma` and imported as `@/generated/prisma/client`, never
  `@prisma/client`. The directory is gitignored and regenerated by
  `prisma generate` — which `npm run build`, the `postinstall` and the Dockerfile
  all run. Never edit it, and never commit it.
- **A driver adapter is mandatory**, so `new PrismaClient()` takes one.
  `lib/db.ts` is the only place that constructs it.
- **Prisma owns no connection pool.** `pg` does. `connection_limit`,
  `pool_timeout` and `schema` in `DATABASE_URL` are Prisma inventions that `pg`
  silently ignores, so `lib/dbConfig.ts` translates all three into adapter
  options. If you touch that file, keep `dbConfig.test.ts` and the README's
  small-NAS troubleshooting row in step — dropping a parameter there fails
  quietly, and in the case of `pool_timeout` it fails by hanging rather than
  erroring.

What did *not* go away is the **schema engine**: `@prisma/engines` still ships a
platform-specific binary, and `prisma migrate deploy` uses it on every container
start. That is why the Dockerfile still builds `prod-deps` on the runner's own
Alpine base, and why that stage must keep running install scripts.

Prisma 7 is also **bigger** than 6, not smaller. Losing the Rust query engine
sounds like a saving and is not one: the WASM query compilers that replaced it
ship one per database engine — five of them, ~71MB — and `prisma` being a
runtime dependency drags Prisma Studio's entire browser UI (`@prisma/studio-core`,
`@visx`, `elkjs`) into the production tree. The Dockerfile's `prod-deps` stage
trims the two pieces that are provably unreachable here — the non-postgresql
compilers, and `typescript` — in the *same* `RUN` as `npm ci`, because deleting
in a later layer saves nothing.

Most of the rest only looks like dead weight. `migrate deploy` eagerly requires
`@prisma/studio-core` and `@prisma/dev`, and `@prisma/config` reaches `effect`,
which reaches `fast-check`; removing any of them breaks migrations at boot, not
at build. If you extend that trim, keep the two assertions chained onto it:
`prisma -v` walks the same require graph as `migrate deploy` without needing a
database, so a wrong guess fails the build instead of somebody's container.

---

## Migrations

Migrations are **hand-written SQL** under
`prisma/migrations/<timestamp>_<snake_case_name>/migration.sql`, applied with
`prisma migrate deploy` (the Docker entrypoint runs this on every start). The
timestamp prefix just has to sort after the previous one — it is not a real
date.

To add one:

1. Edit `prisma/schema.prisma`, keeping the explanatory comments in that file's
   style.
2. Create the migration directory and write the SQL by hand, with a header
   comment explaining *why* the change exists and any data backfill.
3. `npx prisma generate`.
4. Apply it to your scratch database and run the integration suite.

Data that depends on `AUTH_SECRET` (encryption at rest) **cannot** be handled in
SQL — the database has no access to the key. That work belongs in the boot-time
migration in `instrumentation.ts` / `lib/secrets.ts`, which is idempotent and
non-fatal. Reads must always tolerate both the old and new form so a migration
that has not run yet is harmless.

Never rewrite a migration that has shipped.

---

## Testing

Two suites, split by whether they need infrastructure.

**Unit — `src/**/*.test.{ts,tsx}`**, run by `npm test`, environment `node`, no
database and no network. Covers pure decision logic and anything mockable:
`planItem`'s matrix, session tokens, auth guards, password hashing, rate
limiting, provider matching, encryption, the SSRF guard, sweep scheduling, the
webhook payload/token/addressing rules, the sweep queue's claim lifecycle, the
concurrency pool, and the *arr clients' wire format (fetch-mocked).

**Integration — `src/**/*.itest.ts`**, run by `npm run test:integration` against
a real Postgres, stubbing only outbound HTTP. `fileParallelism` is off (shared
database). Use the fixtures in `src/test/dbHelpers.ts` and call `resetDatabase()`
in `beforeEach` — every test builds only the rows it cares about.

**Component tests** opt into a DOM per file with a docblock on line 1:

```ts
// @vitest-environment jsdom
```

This is a file-level annotation on purpose — Vitest's `environmentMatchGlobs` is
being removed, the docblock is not. Do not add a global jsdom environment.

`src/test/sw.test.ts` is the odd one: it loads the shipped `public/sw.js` and
drives its handlers against a stand-in scope, because what matters there is what
must *never* be cached.

---

## CI and the Node version

`.github/workflows/ci.yml` runs on every push and PR. **`verify` and `image`
are both required**:

- `verify` — `check:node` → `npm ci` → `prisma generate` → audit (fails only on
  **critical**) → lint → typecheck → unit tests → `migrate deploy` against a
  Postgres service container → integration tests → `next build`.
- `image-build` — builds the Dockerfile on **amd64 and arm64**, both natively,
  no push. An arm64-only break used to reach `main` and surface at publish.
- `image` — an aggregator that fails unless every `image-build` leg succeeded.
  It exists purely to keep one stable required-check name: making `image` a
  matrix directly would rename the checks to `image (linux/amd64)` and
  `image (linux/arm64)`, leaving branch protection waiting on an `image` that
  never reports again. It uses `if: ${{ !cancelled() }}` and an explicit result
  test, because a job skipped by a failed dependency reports as *skipped*, and a
  skipped required check can satisfy the rule it was meant to enforce. Not
  `always()`, which is true even inside a **cancelled** run — the aggregator
  then read `image-build` as `cancelled` and failed the required check on a run
  the concurrency group had merely superseded.

`verify` passing does **not** imply the image builds, which is why `image` is
separately required.

CI is serialised per branch by a `concurrency` group keyed on
`github.head_ref || github.ref_name` — the one expression both event types
agree on, since a push has no `head_ref` and a `pull_request`'s `ref_name` is
`<n>/merge`. Without it the two triggers each started a full run of the same
commit, and a duplicate stuck queued holds a required check pending with
nothing to read. `cancel-in-progress` is on everywhere **except `main`**, which
keeps a complete verdict per commit; unlike `docker-publish.yml`, nothing here
is unsafe to interrupt.

`.nvmrc` is the single source of truth for the Node major. `npm run check:node`
asserts that the Dockerfile's `FROM node:` lines, `engines.node`, and CI's
`node-version-file` all agree — CI and the shipped image once drifted two majors
apart for months with nothing failing. **Bumping Node means changing `.nvmrc`,
`Dockerfile` (every stage) and `engines.node` together.**

Dependabot runs weekly and **excludes major bumps** for npm and Docker
(deliberately — every breakage this repo has had arrived as an auto-generated
major). Majors are a human decision. Action majors are allowed.

Images publish to GHCR from `main` and `v*.*.*` tags only, stamped with
`APP_COMMIT` / `APP_BUILT_AT` build args that surface in **Settings → Info**.

`docker-publish.yml` is serialised by a repository-wide `concurrency` group,
because it moves `latest` and two runs in flight have no ordering between them —
whichever finishes last wins, so a slower run on an older commit can leave
`latest` pointing backwards. It does **not** cancel in progress: a publish
pushes per-architecture digests before assembling them, so interrupting one can
leave digests no tag references. A burst of merges therefore publishes the
newest commit and may skip the `sha-` image for ones superseded in between.

`docker-publish.yml` builds each architecture on a runner of that architecture
(`ubuntu-latest` and `ubuntu-24.04-arm`), pushes both **by digest with no tag**,
and only then stitches them into one multi-arch tag in a `merge` job — so
`latest` never names a half-published image. It used to build both on one
runner under QEMU, where the arm64 `npm ci` hung for 43 minutes and took the
publish down; that layer is normally a cache hit, so the emulated install
almost never ran and the flakiness stayed hidden until a lockfile change forced
it. If you add a build arg that must be identical across architectures, compute
it in `prepare` and thread it through — `APP_BUILT_AT` is there for exactly
that reason.

**The Dockerfile ships `npm ci --omit=dev`.** `deps` installs everything
(`next build` type-checks, so the build needs `typescript` and `@types/*`);
`prod-deps` installs the runtime tree and that is what the runner copies.
Anything the *running container* needs is therefore a real `dependency` — which
is why `prisma` is one: `docker-entrypoint.sh` runs `prisma migrate deploy` at
startup. That worked before only because the image happened to carry every
devDependency; against a runtime tree built with `--omit=dev`, a build-only
classification would leave `npx` reaching for the network on every boot. Put
build-only tooling in `devDependencies` and expect it not to exist at runtime.

---

## UI conventions

- **Server components by default.** `src/app/page.tsx` fetches through
  `lib/dashboard.ts` directly. Client components carry `"use client"` and fetch
  via SWR + `fetcher` from `lib/fetcher.ts`.
- Routes that read the database declare `export const dynamic = "force-dynamic"`.
- **Settings is a set of independent cards** in `src/components/settings/`. Each
  owns its own form state, saves itself (`PATCH /api/settings` or a dedicated
  endpoint), and calls `onChange()` to revalidate. Shared shapes live in
  `settings/types.ts`; the tab strip lives in `lib/settingsTabs.ts`, which
  exists so **Info stays last** structurally rather than by convention.
- Local state seeded from a revalidating SWR value uses `useSyncedState` — not
  `useEffect`.
- Styling is global CSS classes (`card`, `btn primary`, `banner ok|err|warn`,
  `field`, `hint`, `input`, `toggle-line`) plus occasional inline `style` for
  one-offs. Colours come from CSS custom properties (`var(--accent)`,
  `var(--danger)`) so both themes work; never hardcode a hex in a component.
- Theme is `data-theme` on `<html>` (`dark` | `light` | `system`), set before
  paint by an inline script in `layout.tsx` to avoid a flash.
- Errors must be surfaced, never left as a permanent "Loading…". The Info tab in
  particular renders outside the settings fetch, because it is the tab you open
  *when* `/api/settings` is what is broken.

---

## Environment variables

`.env.example` documents all of them with the reasoning. The load-bearing ones:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Required. Raise `connection_limit` on low-CPU hosts. |
| `AUTH_SECRET` | Required in production (≥16 chars); the app refuses to boot without it. Signs sessions **and** derives the at-rest encryption key. Changing it makes stored credentials unreadable. |
| `AUTH_COOKIE_INSECURE` | `true` when served over plain HTTP, or login silently fails. |
| `PUBLIC_URL` | Required behind a reverse proxy so the OIDC `redirect_uri` matches. |
| `TRUST_PROXY` | Only with a proxy that *overwrites* `X-Forwarded-*`; it feeds the login rate limiter. |
| `SSRF_ALLOW_PRIVATE` | `true` when the *arr apps are on a private LAN. |
| `SYNC_CONCURRENCY` | Default 4, max 32. Raise `connection_limit` alongside it. |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`. |
| `TITLE_MAP_SCHEDULER`, `SWEEP_SCHEDULER` | `off` opts one replica out of a timer. Sweep slots and queued webhook titles are both claimed atomically, so multiple replicas are safe either way. `SWEEP_SCHEDULER=off` also stops the webhook queue worker — an instance with it set still *accepts* webhooks, so at least one instance must be left without it or the queue only grows. |
| `WEBHOOK_SWEEP_DELAY_SECONDS` | How long a webhook-queued title settles before its sweep (default 60, capped at 3600). Sonarr fires "On Series Add" before it has fetched the episode list, so this is what makes sure there is something to sweep. |

---

## Git

- Commit subjects are **descriptive sentence case, imperative, no prefix** —
  "Allow several Watchmode API keys, used in turn", "Stop the Postgres
  healthcheck logging a FATAL every five seconds". Not Conventional Commits.
  Say what changed for the user, not which files moved.
- Work happens on branches; `main` is protected by both required checks.
- There is no PR template in this repo.
