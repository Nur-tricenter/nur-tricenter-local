#!/usr/bin/env bash
# =============================================================================
#  start-infrastructure.sh - Unix counterpart of start-infrastructure.ps1
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_INFRA_FILE="$REPO_ROOT/compose/docker-compose.infra.yml"

EXPECTED=(nur-tricenter-postgres nur-tricenter-rabbitmq nur-tricenter-consul)
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
if ! docker network ls --format '{{.Name}}' | grep -qx 'nur-tricenter-net'; then
    echo "Creating network nur-tricenter-net"
    docker network create nur-tricenter-net >/dev/null
fi

# Remove any containers that already exist under the expected names.
for n in "${EXPECTED[@]}"; do
    existing=$(docker ps -a --filter "name=^${n}$" --format '{{.Names}}' | head -n1)
    if [ -n "$existing" ]; then
        echo "Removing existing container $n (volumes are preserved)"
        docker rm -f "$n" >/dev/null
    fi
done

# Ensure the postgres data volume exists.
if ! docker volume ls --format '{{.Name}}' | grep -qx 'nur-tricenter-postgres-data'; then
    echo "Creating volume nur-tricenter-postgres-data"
    docker volume create nur-tricenter-postgres-data >/dev/null
fi

echo "Lifting infrastructure from docker-compose.infra.yml ..."
docker compose -f "$COMPOSE_INFRA_FILE" up -d >/dev/null

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
        docker ps --filter "name=^nur-tricenter-" --format 'table {{.Names}}\t{{.Status}}' >&2
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
