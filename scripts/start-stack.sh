#!/usr/bin/env bash
# =============================================================================
#  start-stack.sh - Unix counterpart of start-stack.ps1
#
#  Layout reminder:
#    scripts/         -> this file
#    ../compose/      -> docker-compose.yml + docker-compose.infra.yml
#    ../topology/     -> rabbitmq topology + postgres init scripts
#    ../../<sibling>  -> ../.. from here reaches the workspace root where
#                         the catalog and api-gateway repos live
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_DIR="$REPO_ROOT/compose"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yml"
COMPOSE_INFRA_FILE="$COMPOSE_DIR/docker-compose.infra.yml"
CATALOG_ROOT="$REPO_ROOT/../ms2-plans-and-recipes-catalog"
GATEWAY_ROOT="$REPO_ROOT/../nur-tricenter-api-gateway"
# ms5's folder name differs between clones; the compose include reads the same variable.
NURTRICENTER_ROOT="$REPO_ROOT/../${NURTRICENTER_REPO_DIR:-nurtricenter-logistics-and-delivery}"

# 0. Make sure no stale containers are squatting the names we need.
EXPECTED=(
    nur-tricenter-postgres nur-tricenter-rabbitmq nur-tricenter-consul
    nur-tricenter-catalog-api nur-tricenter-catalog-workerservice
    nur-tricenter-nurtricenter-api nur-tricenter-nurtricenter-workerservice
    nur-tricenter-gateway
)
for name in "${EXPECTED[@]}"; do
    if docker ps -a --filter "name=^${name}$" --format '{{.Names}}' | grep -qx "$name"; then
        echo "Removing existing container $name (volumes are preserved)"
        docker rm -f "$name" >/dev/null
    fi
done

# The compose file declares the network as external; create it here so a
# clean host can `start-stack` without first running start-infrastructure.
# Idempotent: if it already exists, do nothing. Inspect-then-create keeps
# Docker 29.x (which dropped --ignore-existing) happy.
if ! docker network ls --format '{{.Name}}' | grep -qx 'nur-tricenter-net'; then
    docker network create nur-tricenter-net >/dev/null
fi

# 1. Build the three business projects.
echo "Building catalog and gateway ..."
dotnet build "$CATALOG_ROOT/src/Catalog.App/Catalog.App.csproj" -c Debug >/dev/null
dotnet build "$CATALOG_ROOT/src/Catalog.WorkerService/Catalog.WorkerService.csproj" -c Debug >/dev/null
dotnet build "$NURTRICENTER_ROOT/src/Nurtricenter.Api/Nurtricenter.Api.csproj" -c Debug >/dev/null
dotnet build "$NURTRICENTER_ROOT/src/Nurtricenter.WorkerService/Nurtricenter.WorkerService.csproj" -c Debug >/dev/null
dotnet build "$GATEWAY_ROOT/ApiGateway.App/ApiGateway.App.csproj" -c Debug >/dev/null

# 2. Bring up infra + 3 business processes in one shot.
echo "Starting infra + business processes via docker compose ..."
docker compose -f "$COMPOSE_FILE" -f "$COMPOSE_INFRA_FILE" -p nur-tricenter up -d

# 3. Apply the schema.
export ConnectionStrings__CatalogDbConnectionString='Host=localhost;Port=5433;Database=ms2-plans-and-recipes-catalog;Username=dev-only;Password=dev-only-password'
export ASPNETCORE_ENVIRONMENT=Development

MIGRATE_DLL="$CATALOG_ROOT/src/Catalog.App/bin/Debug/net8.0/Catalog.App.dll"
echo "Applying catalog schema ..."
dotnet "$MIGRATE_DLL" --migrate

cat <<EOF

Stack ready.
  - Consul UI:    http://localhost:8500
  - RabbitMQ UI:  http://localhost:15672  (guest / guest)
  - Gateway:      http://localhost:15005
  - Catalog API:   internal only (reachable through the gateway as /api/catalog/v1/...)
  - ms5 API:       internal only (reachable through the gateway as /api/nurtricenter/v1/...)

Test the gateway with:
  curl http://localhost:15005/api/catalog/v1/foods

ms5 uses its own Neon database: ConnectionStrings__DefaultConnection in $NURTRICENTER_ROOT/.env
EOF
