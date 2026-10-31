#!/usr/bin/env bash
# =============================================================================
#  start-stack.sh - Unix counterpart of start-stack.ps1
#
#  Layout reminder:
#    scripts/         -> this file
#    ../compose/      -> docker-compose.yml + docker-compose.infra.yml
#    ../topology/     -> rabbitmq topology + postgres init scripts
#    ../../<sibling>  -> ../.. from here reaches the workspace root where
#                         the catalog, identity, delivery calendar (ms4) and
#                         api-gateway repos live
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
IDENTITY_ROOT="$REPO_ROOT/../nur-tricenter-identity"
MS1_ROOT="$REPO_ROOT/../ms1-gestion-clinica-nutricional"
MS4_ROOT="$REPO_ROOT/../ms4-delivery-schedule-management"
MS3_ROOT="$REPO_ROOT/../ms3-contract-and-production"
# ms5's folder name differs between clones; the compose include reads the same variable.
NURTRICENTER_ROOT="$REPO_ROOT/../${NURTRICENTER_REPO_DIR:-ms5-logistics-and-delivery}"

# 0. Make sure no stale containers are squatting the names we need.
EXPECTED=(
    nur-tricenter-postgres nur-tricenter-rabbitmq nur-tricenter-consul
    nur-tricenter-clinica-nutricional-migrate nur-tricenter-clinica-nutricional-api nur-tricenter-clinica-nutricional-workerservice
    nur-tricenter-catalog-api nur-tricenter-catalog-workerservice
    nur-tricenter-identity-migrate nur-tricenter-identity-api nur-tricenter-identity-workerservice
    nur-tricenter-delivery-calendar-migrate nur-tricenter-delivery-calendar-api nur-tricenter-delivery-calendar-workerservice
    nur-tricenter-nurtricenter-migrate nur-tricenter-nurtricenter-api nur-tricenter-nurtricenter-workerservice
    nur-tricenter-contracting-api nur-tricenter-contracting-workerservice
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

# 1. Build the business projects (their output folders are bind-mounted).
echo "Building catalog, identity, ms5, gateway, clinica nutricional (ms1), delivery calendar (ms4) and contracting (ms3) ..."
dotnet build "$CATALOG_ROOT/src/Catalog.App/Catalog.App.csproj" -c Debug >/dev/null
dotnet build "$CATALOG_ROOT/src/Catalog.WorkerService/Catalog.WorkerService.csproj" -c Debug >/dev/null
dotnet build "$IDENTITY_ROOT/src/Identity.App/Identity.App.csproj" -c Debug >/dev/null
dotnet build "$IDENTITY_ROOT/src/Identity.WorkerService/Identity.WorkerService.csproj" -c Debug >/dev/null
dotnet build "$NURTRICENTER_ROOT/src/Nurtricenter.Api/Nurtricenter.Api.csproj" -c Debug >/dev/null
dotnet build "$NURTRICENTER_ROOT/src/Nurtricenter.WorkerService/Nurtricenter.WorkerService.csproj" -c Debug >/dev/null
dotnet build "$GATEWAY_ROOT/ApiGateway.App/ApiGateway.App.csproj" -c Debug >/dev/null
dotnet build "$MS1_ROOT/GestionClinicaNutricionalService.WebApi/GestionClinicaNutricionalService.WebApi.csproj" -c Debug >/dev/null
dotnet build "$MS1_ROOT/GestionClinicaNutricional.WorkerService/GestionClinicaNutricional.WorkerService.csproj" -c Debug >/dev/null
# MS4 builds into its own artifacts/ folder (ArtifactsPath), which ms4.compose.yml bind-mounts.
dotnet build "$MS4_ROOT/src/Api/Api.csproj" -c Debug >/dev/null
dotnet build "$MS4_ROOT/src/WorkerService/WorkerService.csproj" -c Debug >/dev/null
dotnet build "$MS3_ROOT/Nurtricenter.Api/Nurtricenter.MS3.Api.csproj" -c Debug >/dev/null
dotnet build "$MS3_ROOT/Nurtricenter.MS3.WorkerService/Nurtricenter.MS3.WorkerService.csproj" -c Debug >/dev/null
# Presentation dashboard (http://localhost:15100), lives in this repository.
dotnet build "$(dirname "$0")/../demo-console/src/DemoConsole/DemoConsole.csproj" -c Debug >/dev/null

# 2. Infra first, then make sure every database exists. Postgres runs postgres-init/ only on
# a brand-new volume, so a volume created before a service was added lacks its database and
# that service's migrate job fails. The script is idempotent (CREATE only when missing).
echo "Starting infra (postgres, rabbitmq, consul) ..."
docker compose -f "$COMPOSE_INFRA_FILE" -p nur-tricenter up -d --wait
echo "Ensuring every service database exists ..."
# MSYS_NO_PATHCONV: Git Bash on Windows would rewrite the in-container path below.
MSYS_NO_PATHCONV=1 docker exec nur-tricenter-postgres psql -q -U dev-only -d postgres \
    -f /docker-entrypoint-initdb.d/01-create-databases.sql >/dev/null

# 3. Business processes.
echo "Starting business processes via docker compose ..."
docker compose -f "$COMPOSE_FILE" -f "$COMPOSE_INFRA_FILE" -p nur-tricenter up -d

# 3. Apply the catalog schema. The catalog Startup calls AddSecurity, which refuses
# to compose without a signing key, so the host migrate step needs Jwt__* too.
export ConnectionStrings__CatalogDbConnectionString='Host=localhost;Port=5433;Database=ms2-plans-and-recipes-catalog;Username=dev-only;Password=dev-only-password'
export ASPNETCORE_ENVIRONMENT=Development
export Jwt__SecretKey='dev-only-signing-key-not-a-secret-0123456789'
export Jwt__ValidIssuer='nur-tricenter-identity'
export Jwt__ValidAudience='nur-tricenter-clients'
export Jwt__Lifetime='3600'

MIGRATE_DLL="$CATALOG_ROOT/src/Catalog.App/bin/Debug/net8.0/Catalog.App.dll"
echo "Applying catalog schema ..."
dotnet "$MIGRATE_DLL" --migrate

# 4. MS4's service account (catalog.mealPlan:read), created through the gateway with the
# seeded admin's token. Idempotent: 409 means it already exists. The gateway learns
# identity's route from Consul within ~30s, hence the retry loop.
GATEWAY='http://localhost:15005'
ADMIN_TOKEN=''
for _ in $(seq 1 24); do
    ADMIN_TOKEN="$(curl -fsS -X POST "$GATEWAY/api/identity-service/v1/auth/login" \
        -H 'Content-Type: application/json' -d '{"userName":"admin","password":"admin"}' 2>/dev/null \
        | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p' || true)"
    [ -n "$ADMIN_TOKEN" ] && break
    sleep 5
done
if [ -z "$ADMIN_TOKEN" ]; then
    echo "Could not log in to identity through the gateway to create MS4's service account" >&2
    exit 1
fi

STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$GATEWAY/api/identity-service/v1/users" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
    -d '{"userName":"ms4-service","email":"ms4-service@nur.local","password":"dev-only-ms4-service-password","scopes":["catalog.mealPlan:read"]}')"
case "$STATUS" in
    2*)  echo "Created MS4 service account 'ms4-service'." ;;
    409) echo "MS4 service account 'ms4-service' already exists." ;;
    *)   echo "Creating MS4's service account failed with HTTP $STATUS" >&2; exit 1 ;;
esac

# MS3's service account: MS3 calls MS4 to create the delivery calendar after a payment
# (deliveryCalendar.calendar:create) and to read tomorrow's production order
# (deliveryCalendar.productionOrder:read). Same idempotent creation as MS4's.
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$GATEWAY/api/identity-service/v1/users" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
    -d '{"userName":"ms3-service","email":"ms3-service@nur.local","password":"dev-only-ms3-service-password","scopes":["deliveryCalendar.calendar:create","deliveryCalendar.productionOrder:read"]}')"
case "$STATUS" in
    2*)  echo "Created MS3 service account 'ms3-service'." ;;
    409) echo "MS3 service account 'ms3-service' already exists." ;;
    *)   echo "Creating MS3's service account failed with HTTP $STATUS" >&2; exit 1 ;;
esac

cat <<EOF

Stack ready.
  - Consul UI:    http://localhost:8500
  - RabbitMQ UI:  http://localhost:15672  (guest / guest)
  - Gateway:      http://localhost:15005
  - Demo console: http://localhost:15100  (presentation dashboard)
  - Catalog API:   internal only (reachable through the gateway as /api/catalog/v1/...)
  - Delivery calendar (ms4): internal only (through the gateway as /api/delivery-calendar/v1/...)
  - ms5 API:       internal only (reachable through the gateway as /api/nurtricenter/v1/...)

Test the gateway with:
  curl http://localhost:15005/api/catalog/v1/foods

ms5 database: ConnectionStrings__DefaultConnection in $NURTRICENTER_ROOT/.env (its schema is applied by the nurtricenter-migrate job)
EOF
