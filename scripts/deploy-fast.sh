#!/usr/bin/env bash
# Fast deploy: BuildKit cache + only the services you pass (default: web api).
set -euo pipefail
cd "$(dirname "$0")/.."

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

SERVICES="${*:-web api}"
echo "==> Building: $SERVICES"
docker compose build --parallel $SERVICES

echo "==> Recreating: $SERVICES"
docker compose up -d --force-recreate --no-deps $SERVICES

if echo " ${SERVICES} " | grep -q ' api '; then
  echo "==> DB migrations (api container)"
  docker compose exec -T api sh -c 'cd /repo && pnpm --filter @gdms/database exec prisma migrate deploy' 2>/dev/null || \
    DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/gdms?schema=public}" \
      pnpm --filter @gdms/database exec prisma migrate deploy
fi

echo "==> Done"
docker compose ps $SERVICES
