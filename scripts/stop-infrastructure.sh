#!/usr/bin/env bash
# =============================================================================
#  stop-infrastructure.sh
#  Unix counterpart of stop-infrastructure.ps1.
#
#    ./stop-infrastructure.sh         # keeps the volume
#    ./stop-infrastructure.sh -v      # also drops the volume
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_INFRA_FILE="$(cd "$SCRIPT_DIR/.." && pwd)/compose/docker-compose.infra.yml"

if [ "${1:-}" = "-v" ]; then
    docker compose -f "$COMPOSE_INFRA_FILE" down --volumes
else
    docker compose -f "$COMPOSE_INFRA_FILE" down
fi
