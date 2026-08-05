# Multi-stage build for the StreamSweeparr Next.js app.

FROM node:25-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# Reproducible install from the lockfile.
RUN npm ci

FROM node:25-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DATABASE_URL is not needed for `prisma generate` / `next build`.
RUN npx prisma generate && npm run build

FROM node:25-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl

# Copy the built app. Ownership is set to the built-in unprivileged `node` user.
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh

# Run as a non-root user.
USER node

EXPOSE 3000
# Apply migrations (safe, versioned) then start.
ENTRYPOINT ["./docker-entrypoint.sh"]
