#!/usr/bin/env bash
# =============================================================================
#  start-stack.sh - Unix counterpart of start-stack.ps1
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 0. Make sure no stale containers are squatting the names we need.
EXPECTED=(
    ms2-plans-and-recipes-catalog-postgres ms2-plans-and-recipes-catalog-rabbitmq ms2-plans-and-recipes-catalog-consul
    ms2-plans-and-recipes-catalog-catalog-webapi ms2-plans-and-recipes-catalog-catalog-workerservice ms2-plans-and-recipes-catalog-apigateway-webapp
)
for name in "${EXPECTED[@]}"; do
    if docker ps -a --filter "name=^${name}$" --format '{{.Names}}' | grep -qx "$name"; then
        echo "Removing existing container $name (volumes are preserved)"
        docker rm -f "$name" >/dev/null
    fi
done

# The compose file declares the network as external; create it here so a
# clean host can `start-stack` without first running start-infrastructure.
# Idempotent: if it already exists, do nothing.
if ! docker network ls --format '{{.Name}}' | grep -qx 'ms2-plans-and-recipes-catalog-net'; then
    docker network create ms2-plans-and-recipes-catalog-net >/dev/null
fi

# 1. Build the three business projects.
echo "Building catalog and gateway ..."
dotnet build "$SCRIPT_DIR/../ms2-plans-and-recipes-catalog/src/Catalog.WebApi/Catalog.WebApi.csproj" -c Debug >/dev/null
dotnet build "$SCRIPT_DIR/../ms2-plans-and-recipes-catalog/src/Catalog.WorkerService/Catalog.WorkerService.csproj" -c Debug >/dev/null
dotnet build "$SCRIPT_DIR/../ms2-plans-and-recipes-catalog-api-gateway/ApiGateway.WebApp/ApiGateway.WebApp.csproj" -c Debug >/dev/null

# 2. Bring up the entire stack in one shot: infra + 3 business processes.
echo "Starting infra + business processes via docker compose ..."
docker compose up -d

# 3. Apply the schema.
export ConnectionStrings__CatalogDbConnectionString='Host=localhost;Port=5433;Database=ms2-plans-and-recipes-catalog;Username=dev-only;Password=dev-only-password'
export ASPNETCORE_ENVIRONMENT=Development

MIGRATE_DLL="$SCRIPT_DIR/../ms2-plans-and-recipes-catalog/src/Catalog.WebApi/bin/Debug/net10.0/Catalog.WebApi.dll"
echo "Applying catalog schema ..."
dotnet "$MIGRATE_DLL" --migrate

cat <<EOF

Stack ready.
  - Consul UI:    http://localhost:8500
  - RabbitMQ UI:  http://localhost:15672  (catalogUser / catalogUserPassword)
  - Gateway:      http://localhost:15005
  - WebApi:       internal only (reachable through the gateway as /api/catalog/v1/...)

Test the gateway with:
  curl http://localhost:15005/api/catalog/v1/foods
EOF
