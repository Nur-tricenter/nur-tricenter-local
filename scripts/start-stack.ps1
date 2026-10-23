# =============================================================================
#  start-stack.ps1
#  Brings up the full Nur-Tricenter stack with the ms2-plans-and-recipes-catalog
#  microservice deployed on top.
#
#    1. dotnet build               catalog and gateway (output volumes are bind-mounted)
#    2. docker compose up -d       platform infra + the three business processes
#    3. apply --migrate           schema (on the host, against the platform postgres)
#
#  This is dev-only. The Fase 7 Dockerfile will replace the bind-mount with
#  proper image builds. Until then, editing any of the three business
#  projects means: re-run `dotnet build` from the project's directory,
#  then `docker compose restart <service>` here.
#
#  `start-infrastructure.ps1` is still useful on its own: it brings up
#  only the three platform containers (Postgres, RabbitMQ, Consul)
#  without the business processes.
#
#  Layout reminder:
#    scripts/         -> this file
#    ../compose/      -> docker-compose.yml + docker-compose.infra.yml
#    ../topology/     -> rabbitmq.conf + rabbitmq-definitions.json + postgres-init/
#    ../../<sibling>  -> ../.. from here reaches the workspace root where
#                         the catalog and api-gateway repos live
# =============================================================================

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Resolve the absolute paths once. Using absolute paths everywhere keeps the
# rest of the script readable: no need to count ../ between operations.
$repoRoot          = Split-Path -Parent $scriptDir           # the orchestrator repo root
$composeDir        = Join-Path $repoRoot 'compose'
$composeFile       = Join-Path $composeDir 'docker-compose.yml'
$composeInfraFile  = Join-Path $composeDir 'docker-compose.infra.yml'
$catalogRoot       = Join-Path $repoRoot '..\ms2-plans-and-recipes-catalog'
$gatewayRoot       = Join-Path $repoRoot '..\nur-tricenter-api-gateway'
$identityRoot      = Join-Path $repoRoot '..\nur-tricenter-identity'

# 0. Make sure no stale containers are squatting the names we need. Same
# pattern as start-infrastructure.ps1: rm first, then up. The named
# volumes survive.
$expected = @(
    # Platform
    'nur-tricenter-postgres','nur-tricenter-rabbitmq','nur-tricenter-consul',
    # Microservice processes (container_name declared in docker-compose.yml)
    'nur-tricenter-catalog-api','nur-tricenter-catalog-workerservice',
    # Platform: gateway (container_name declared in docker-compose.yml)
    'nur-tricenter-gateway'
)
foreach ($name in $expected) {
    $existing = docker ps -a --filter "name=^${name}$" --format '{{.Names}}' | Select-Object -First 1
    if ($existing) {
        Write-Host "Removing existing container $name (volumes are preserved)"
        docker rm -f $name | Out-Null
    }
}

# Create the platform network if it does not exist; compose declares it as
# external, so a clean host can `start-stack` without first running
# start-infrastructure. Idempotent. Docker 29.x dropped the
# `--ignore-existing` flag; inspect-then-create handles both branches.
$netName = 'nur-tricenter-net'
$existingNet = docker network ls --filter "name=^${netName}$" --format '{{.Name}}' | Select-Object -First 1
if (-not $existingNet) {
    docker network create $netName | Out-Null
}

# 1. Build the business projects on the host. The compose file
# bind-mounts the output bin/Debug/ directories. Identity is included here
# (it was previously a manual step) so the whole stack comes up from one command.
Write-Host "Building catalog, identity and gateway ..."
& dotnet build (Join-Path $catalogRoot 'src\Catalog.App\Catalog.App.csproj')              -c Debug | Out-Null
& dotnet build (Join-Path $catalogRoot 'src\Catalog.WorkerService\Catalog.WorkerService.csproj') -c Debug | Out-Null
& dotnet build (Join-Path $identityRoot 'src\Identity.App\Identity.App.csproj')            -c Debug | Out-Null
& dotnet build (Join-Path $identityRoot 'src\Identity.WorkerService\Identity.WorkerService.csproj') -c Debug | Out-Null
& dotnet build (Join-Path $gatewayRoot 'ApiGateway.App\ApiGateway.App.csproj')            -c Debug | Out-Null

# 2. Bring up infra + business processes in one shot. docker compose writes
# informational lines to stderr, which with $ErrorActionPreference='Stop' would
# abort the script even on a successful up. Run it with the preference relaxed
# and discard its output; the exit code is what matters.
Write-Host "Starting infra + business processes via docker compose ..."
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
docker compose -f $composeFile -f $composeInfraFile -p nur-tricenter up -d 2>&1 | Out-Null
$composeExit = $LASTEXITCODE
$ErrorActionPreference = $previousErrorAction
if ($composeExit -ne 0) { throw "docker compose up failed with exit code $composeExit" }

# 3. Apply the schema. The migration runs on the host against the
# platform postgres's catalog database. Inside docker, the database is
# reachable at localhost:5433 because the compose maps the container
# port 5432 to the host.
#
# Since this compose sets Migrations__ApplyOnStartup=true on the
# catalog-api container, the container applies the migration itself
# during boot. Running --migrate here is belt-and-suspenders: it makes
# the schema visible to other tools (psql, Entity Framework designer)
# before any container restarts, and it stays idempotent because the
# migrator is a no-op when no new migration is pending.
$conn = 'Host=localhost;Port=5433;Database=ms2-plans-and-recipes-catalog;Username=dev-only;Password=dev-only-password'
$env:ConnectionStrings__CatalogDbConnectionString = $conn
$env:ASPNETCORE_ENVIRONMENT                     = 'Development'
# The catalog Startup calls AddSecurity, which refuses to compose without a
# signing key. The container supplies it through compose; the host migrate
# step needs it too.
$env:Jwt__SecretKey    = 'dev-only-signing-key-not-a-secret-0123456789'
$env:Jwt__ValidIssuer  = 'nur-tricenter-identity'
$env:Jwt__ValidAudience = 'nur-tricenter-clients'
$env:Jwt__Lifetime     = '3600'

$migrateDll = Get-ChildItem -Path (Join-Path $catalogRoot 'src\Catalog.App\bin\Debug\net8.0\Catalog.App.dll') | Select-Object -First 1
Write-Host "Applying catalog schema ..."
& dotnet (Join-Path $migrateDll.DirectoryName 'Catalog.App.dll') --migrate
if ($LASTEXITCODE -ne 0) { throw "Catalog schema migration failed" }

Write-Host ""
Write-Host "Stack ready."
Write-Host "  - Consul UI:    http://localhost:8500"
Write-Host "  - RabbitMQ UI:  http://localhost:15672  (guest / guest)"
Write-Host "  - Gateway:      http://localhost:15005"
Write-Host "  - Catalog API:   internal only (reachable through the gateway as /api/catalog/v1/...)"
Write-Host ""
Write-Host "Test the gateway with:"
Write-Host "  curl http://localhost:15005/api/catalog/v1/foods"
Write-Host ""
Write-Host "View tail of a service log with:"
Write-Host "  docker logs -f nur-tricenter-catalog-api"
