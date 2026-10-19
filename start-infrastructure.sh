#!/usr/bin/env bash
# =============================================================================
#  start-infrastructure.sh
#  Unix counterpart of start-infrastructure.ps1. Same idempotency and
#  readiness contract.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

EXPECTED=(ms2-plans-and-recipes-catalog-postgres ms2-plans-and-recipes-catalog-rabbitmq ms2-plans-and-recipes-catalog-consul)
TIMEOUT_SECONDS=120

# Count a container as ready if it is Up (no healthcheck) OR healthy.
ready_count() {
    local count=0
    for n in "${EXPECTED[@]}"; do
        local status
        status=$(docker ps --filter "name=^${n}$" --format '{{.Status}}' | head -n1)
        [ -z "$status" ] && continue
        if echo "$status" | grep -q "healthy"; then
            count=$((count + 1))
        elif echo "$status" | grep -qE '^Up\b' \
            && ! echo "$status" | grep -q 'unhealthy' \
            && ! echo "$status" | grep -q 'Restarting'; then
            count=$((count + 1))
        fi
    done
    echo "$count"
}

# Ensure the network exists.
if ! docker network ls --format '{{.Name}}' | grep -qx 'ms2-plans-and-recipes-catalog-net'; then
    echo "Creating network ms2-plans-and-recipes-catalog-net"
    docker network create ms2-plans-and-recipes-catalog-net >/dev/null
fi

echo "Lifting infrastructure from docker-compose.infra.yml ..."
docker compose -f docker-compose.infra.yml up -d --remove-orphans >/dev/null

echo -n "Waiting for readiness "
deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
while :; do
    sleep 2
    ok=$(ready_count)
    if [ "$ok" -eq "${#EXPECTED[@]}" ]; then
        break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
        echo ""
        echo "ERROR: infrastructure not ready within ${TIMEOUT_SECONDS}s" >&2
        docker ps --filter "name=^ms2-plans-and-recipes-catalog-" --format 'table {{.Names}}\t{{.Status}}' >&2
        exit 1
    fi
    echo -n "."
done
echo ""

echo "Infrastructure ready:"
for n in "${EXPECTED[@]}"; do
    port=$(docker port "$n" 2>/dev/null | tr '\n' ',' | sed 's/,$//')
    echo "  - $n  ($port)"
done
