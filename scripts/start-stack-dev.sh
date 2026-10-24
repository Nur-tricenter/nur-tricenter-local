#!/usr/bin/env bash
# =============================================================================
#  start-stack-dev.sh - Unix counterpart of start-stack-dev.ps1
#
#  Base flow + docker-compose.dev.yml layered on top. The dev profile enables
#  the catalog's OpenAPI document on host port 18080:
#
#    http://localhost:18080/swagger                (UI)
#    http://localhost:18080/swagger/v1/swagger.json  (OpenAPI document)
#
#  Application traffic still flows through the gateway at :15005. The extra
#  host port exists only to expose the contract to the workstation for local
#  exploration; production stacks never include the dev profile.
#
#  Layout reminder:
#    scripts/             -> this file
#    ../compose/          -> docker-compose.yml + docker-compose.infra.yml
#    ../compose/dev/      -> docker-compose.dev.yml
#    ../topology/         -> rabbitmq topology + postgres init scripts
#    ../../<sibling>      -> catalog and api-gateway repos live beside this one
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_DIR="$REPO_ROOT/compose"
DEV_COMPOSE_DIR="$COMPOSE_DIR/dev"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yml"
COMPOSE_INFRA_FILE="$COMPOSE_DIR/docker-compose.infra.yml"
COMPOSE_DEV_FILE="$DEV_COMPOSE_DIR/docker-compose.dev.yml"
CATALOG_ROOT="$REPO_ROOT/../ms2-plans-and-recipes-catalog"
GATEWAY_ROOT="$REPO_ROOT/../nur-tricenter-api-gateway"
MS3_ROOT="$REPO_ROOT/../ms3-contract-and-production"

# 0. Make sure no stale containers are squatting the names we need.
EXPECTED=(
    nur-tricenter-postgres nur-tricenter-rabbitmq nur-tricenter-consul
    nur-tricenter-catalog-api nur-tricenter-catalog-workerservice
    nur-tricenter-contracting-api nur-tricenter-contracting-workerservice
    nur-tricenter-gateway
)
for name in "${EXPECTED[@]}"; do
    if docker ps -a --filter "name=^${name}$" --format '{{.Names}}' | grep -qx "$name"; then
        echo "Removing existing container $name (volumes are preserved)"
        docker rm -f "$name" >/dev/null
    fi
done

# Idempotent network creation, mirroring start-stack.sh.
if ! docker network ls --format '{{.Name}}' | grep -qx 'nur-tricenter-net'; then
    docker network create nur-tricenter-net >/dev/null
fi

# 1. Build the three business projects. Same as the base script.
echo "Building catalog and gateway ..."
dotnet build "$CATALOG_ROOT/src/Catalog.App/Catalog.App.csproj" -c Debug >/dev/null
dotnet build "$CATALOG_ROOT/src/Catalog.WorkerService/Catalog.WorkerService.csproj" -c Debug >/dev/null
dotnet build "$GATEWAY_ROOT/ApiGateway.App/ApiGateway.App.csproj" -c Debug >/dev/null
dotnet build "$MS3_ROOT/Nurtricenter.Api/Nurtricenter.MS3.Api.csproj" -c Debug >/dev/null
dotnet build "$MS3_ROOT/Nurtricenter.MS3.WorkerService/Nurtricenter.MS3.WorkerService.csproj" -c Debug >/dev/null

# 2. Bring up infra + business processes, with the dev profile layered on top.
# THIS is the line that differs from start-stack.sh: the third -f picks up
# docker-compose.dev.yml and applies only what is dev-specific.
echo "Starting infra + business processes (dev profile) ..."
docker compose \
    -f "$COMPOSE_FILE" \
    -f "$COMPOSE_INFRA_FILE" \
    -f "$COMPOSE_DEV_FILE" \
    -p nur-tricenter up -d

# 3. Apply the schema. Same as the base script.
export ConnectionStrings__CatalogDbConnectionString='Host=localhost;Port=5433;Database=ms2-plans-and-recipes-catalog;Username=dev-only;Password=dev-only-password'
export ASPNETCORE_ENVIRONMENT=Development

MIGRATE_DLL="$CATALOG_ROOT/src/Catalog.App/bin/Debug/net8.0/Catalog.App.dll"
echo "Applying catalog schema ..."
dotnet "$MIGRATE_DLL" --migrate

cat <<EOF

Dev stack ready.
  - Consul UI:           http://localhost:8500
  - RabbitMQ UI:         http://localhost:15672  (guest / guest)
  - Gateway:             http://localhost:15005
  - Catalog Swagger UI:  http://localhost:18080/swagger
  - Catalog Swagger doc: http://localhost:18080/swagger/v1/swagger.json

  Application traffic still goes through the gateway. The :18080 host port
  is a dev-only convenience for reading the contract in a browser.

Test the gateway with:
  curl http://localhost:15005/api/catalog/v1/foods
EOF
