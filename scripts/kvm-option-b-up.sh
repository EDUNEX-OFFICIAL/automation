#!/usr/bin/env bash
# KVM: control plane + tunnel ports; stop in-container worker/automation for Option B.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)
"${COMPOSE[@]}" -f docker-compose.tunnel.yml up -d postgres redis api web ai
"${COMPOSE[@]}" stop worker automation 2>/dev/null || true
echo "--- listening (expect 127.0.0.1:6380 and :54322) ---"
ss -lntp 2>/dev/null | grep -E '6380|54322' || true
"${COMPOSE[@]}" ps
