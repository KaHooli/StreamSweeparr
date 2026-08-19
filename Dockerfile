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
# Reproducible install from the lockfile.
RUN npm ci

# The runtime tree. Built in the same Alpine base as the runner so the Prisma
# engine that `prisma generate` (the postinstall) selects is the musl one the
# runner can actually execute — generating against a different libc produces a
# client that fails at startup rather than at build.
FROM node:24-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* ./
COPY prisma ./prisma
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
COPY --from=builder --chown=node:node /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh

# Run as a non-root user.
USER node

EXPOSE 3000
# Apply migrations (safe, versioned) then start.
ENTRYPOINT ["./docker-entrypoint.sh"]
