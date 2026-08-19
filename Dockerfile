# Multi-stage build for the StreamSweeparr Next.js app.
#
# The Node major here must match `.nvmrc`, which is what CI installs. They used
# to drift — the image sat on node:25 while CI tested node:20, so neither one
# validated the other. `npm run check:node` enforces the match and runs in CI;
# if you bump one of these lines, bump `.nvmrc` and `engines.node` with it.
#
# There are two dependency stages on purpose, and the split is the point:
#
#   deps      — the full tree. `next build` type-checks, so the build genuinely
#               needs typescript and @types/*, which are devDependencies.
#   prod-deps — `npm ci --omit=dev`. This is the tree that actually ships.
#
# The runner used to take its node_modules from the builder, which meant the
# published image carried vitest, vite, eslint, typescript, jsdom and
# @testing-library — about 180MB and 12,900 files of test tooling that can
# never run in production, plus their install scripts. Two stages cost one
# extra install at build time and take all of that out of the image.

FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# `prisma.config.ts` is what the Prisma 7 CLI reads instead of the datasource
# block that used to live in the schema. The postinstall runs `prisma generate`,
# so it has to be here for that to resolve the same way it does in the builder.
# Generating needs no DATABASE_URL — see the note in that file.
COPY prisma.config.ts ./prisma.config.ts
# Reproducible install from the lockfile.
RUN npm ci

# The runtime tree. Built in the same Alpine base as the runner so the Prisma
# binary that `@prisma/engines`' postinstall downloads is the musl one the
# runner can actually execute.
#
# Prisma 7 narrowed what that binary is, but did not remove it. The Rust *query*
# engine is gone — queries now go through the TypeScript query compiler and the
# pg driver adapter, so serving a request touches no native code. The *schema*
# engine is still a platform-specific executable, and `docker-entrypoint.sh`
# runs `prisma migrate deploy` on every start, so a tree assembled against the
# wrong libc still fails — now at the first boot rather than at the first query.
# That is why this stage keeps its own Alpine base and must keep running install
# scripts: `npm ci --omit=dev --ignore-scripts` would produce a tree that starts
# and then cannot migrate.
FROM node:24-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* ./
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
RUN npm ci --omit=dev

FROM node:24-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build stamps shown in Settings -> Info, so a bug report can name the exact
# image it came from. Both are optional: a plain `docker build` just leaves
# them empty and the tab shows the package version alone.
ARG APP_COMMIT=""
ARG APP_BUILT_AT=""
ENV APP_COMMIT=$APP_COMMIT
ENV APP_BUILT_AT=$APP_BUILT_AT
# DATABASE_URL is not needed for `prisma generate` / `next build`.
RUN npx prisma generate && npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Both tools in the entrypoint check for a newer version of themselves on every
# container start, and both do it over the network.
#
# CHECKPOINT_DISABLE is the one that matters: without it `prisma migrate deploy`
# calls out to checkpoint.prisma.io before applying migrations, so a
# self-hosted install makes an outbound request to a third party every time it
# boots. The "Update available 5.22.0 -> 7.9.1" box in the logs is that
# request's reply, not a local computation. PRISMA_HIDE_UPDATE_MESSAGE only
# suppresses the box; it is set as well so the banner stays gone if Prisma ever
# changes which of the two controls the output.
#
# The npm notice is cosmetic by comparison — npm's version is whatever
# node:24-alpine bundles, and nothing here can act on the advice — but it lands
# in the middle of the migration output and makes a boot log harder to read.
#
# Neither disables anything the app uses. Both are runner-stage only: the build
# stages are allowed to be noisy because a human is reading that output.
ENV CHECKPOINT_DISABLE=1
ENV PRISMA_HIDE_UPDATE_MESSAGE=true
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apk add --no-cache openssl

# Copy the built app. Ownership is set to the built-in unprivileged `node` user.
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next ./.next
# Runtime dependencies only — see the note at the top of this file.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/prisma ./prisma
# Read by `prisma migrate deploy` in the entrypoint. Since Prisma 7 the
# connection URL lives here rather than in schema.prisma, so without it the
# migration step has no datasource and the container never gets past boot.
COPY --from=builder --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=node:node /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh

# Run as a non-root user.
USER node

EXPOSE 3000
# Apply migrations (safe, versioned) then start.
ENTRYPOINT ["./docker-entrypoint.sh"]
