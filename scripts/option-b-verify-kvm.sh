#!/usr/bin/env bash
# Quick KVM-side checks for Option B (run on server after kvm-option-b-up.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)

echo "=== compose ps (worker/automation should be absent or Exited) ==="
"${COMPOSE[@]}" ps

echo ""
echo "=== tunnel ports (127.0.0.1 only) ==="
ss -lntp 2>/dev/null | grep -E '6380|32459' || { echo "FAIL: ports not listening"; exit 1; }

echo ""
echo "=== redis ping via tunnel port ==="
if command -v redis-cli >/dev/null 2>&1; then
  redis-cli -p 6380 ping
else
  docker exec automation-redis-1 redis-cli ping
fi

echo ""
echo "OK — PC can run ssh-tunnel-kvm.ps1 then option-b-start.ps1"
