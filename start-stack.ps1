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
# =============================================================================

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

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
# start-infrastructure. Idempotent.
$netName = 'nur-tricenter-net'
docker network create --ignore-existing $netName | Out-Null

# 1. Build the three business projects on the host. The compose file
# bind-mounts the output bin/Debug/ directories.
Write-Host "Building catalog and gateway ..."
& dotnet build (Join-Path $scriptDir '..\ms2-plans-and-recipes-catalog\src\Catalog.App\Catalog.App.csproj') -c Debug | Out-Null
& dotnet build (Join-Path $scriptDir '..\ms2-plans-and-recipes-catalog\src\Catalog.WorkerService\Catalog.WorkerService.csproj') -c Debug | Out-Null
& dotnet build (Join-Path $scriptDir '..\nur-tricenter-api-gateway\ApiGateway.App\ApiGateway.App.csproj') -c Debug | Out-Null

# 2. Bring up infra + 3 business processes in one shot.
Write-Host "Starting infra + business processes via docker compose ..."
docker compose up -d

# 3. Apply the schema. The migration runs on the host against the
# platform postgres's catalog database. Inside docker, the database is
# reachable at localhost:5433 because the compose maps the container
# port 5432 to the host.
$conn = 'Host=localhost;Port=5433;Database=ms2-plans-and-recipes-catalog;Username=dev-only;Password=dev-only-password'
$env:ConnectionStrings__CatalogDbConnectionString = $conn
$env:ASPNETCORE_ENVIRONMENT                     = 'Development'

$migrateDll = Get-ChildItem -Path (Join-Path $scriptDir '..\ms2-plans-and-recipes-catalog\src\Catalog.App\bin\Debug\net8.0\Catalog.App.dll') | Select-Object -First 1
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
