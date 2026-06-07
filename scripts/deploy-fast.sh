#!/usr/bin/env bash
# Fast deploy: BuildKit cache + only the services you pass (default: web api).
set -euo pipefail
cd "$(dirname "$0")/.."

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

SERVICES="${*:-web api}"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
echo "==> Building: $SERVICES"
$COMPOSE build --parallel $SERVICES

echo "==> Recreating: $SERVICES"
$COMPOSE up -d --force-recreate --no-deps $SERVICES

if echo " ${SERVICES} " | grep -q ' api '; then
  echo "==> DB migrations (api container)"
  $COMPOSE exec -T api sh -c 'cd /repo && pnpm --filter @gdms/database exec prisma migrate deploy' 2>/dev/null || \
    DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:32459/gdms?schema=public}" \
      pnpm --filter @gdms/database exec prisma migrate deploy
fi

echo "==> Done"
$COMPOSE ps $SERVICES
