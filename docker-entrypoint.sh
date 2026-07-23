#!/bin/sh
set -e

# Apply pending database migrations. `migrate deploy` only runs committed
# migrations and never generates destructive changes on its own.
echo "[entrypoint] Applying database migrations…"
npx prisma migrate deploy

echo "[entrypoint] Starting StreamSweeparr…"
exec npm run start
