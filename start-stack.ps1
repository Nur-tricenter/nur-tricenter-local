# =============================================================================
#  start-stack.ps1
#  Brings up the full Nur-Tricenter stack in dev mode.
#
#    1. dotnet build               catalog and gateway (output volumes are bind-mounted)
#    2. docker compose up -d       infra + the three business processes (one shot)
#    3. apply --migrate           schema (on the host, against localhost:5433)
#
#  This is dev-only. The Fase 7 Dockerfile will replace the bind-mount with
#  proper image builds. Until then, editing any of the three business
#  projects means: re-run `dotnet build` from the project's directory,
#  then `docker compose restart <service>` here.
#
#  `start-infrastructure.ps1` is still useful on its own: it brings up
#  only the three infra containers (Postgres, RabbitMQ, Consul) without
#  the business processes, for cases like debugging the catalog against
#  an already-running infra.
# =============================================================================

$ErrorActionPreference = 'Stop'

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# 0. Make sure no stale containers are squatting the names we need. Same
# pattern as start-infrastructure.ps1: rm first, then up. The named
# volumes survive.
$expected = @('ms2-plans-and-recipes-catalog-postgres','ms2-plans-and-recipes-catalog-rabbitmq','ms2-plans-and-recipes-catalog-consul',
              'ms2-plans-and-recipes-catalog-catalog-webapi','ms2-plans-and-recipes-catalog-catalog-workerservice','ms2-plans-and-recipes-catalog-apigateway-webapp')
foreach ($name in $expected) {
    $existing = docker ps -a --filter "name=^${name}$" --format '{{.Names}}' | Select-Object -First 1
    if ($existing) {
        Write-Host "Removing existing container $name (volumes are preserved)"
        docker rm -f $name | Out-Null
    }
}

# The compose file declares the network as external; create it here so a
# clean host can `start-stack` without first running start-infrastructure.
# Idempotent: docker network create fails with "already exists" only if
# the existing one has a different configuration, which the parameter
# --ignore-existing avoids.
$netName = 'ms2-plans-and-recipes-catalog-net'
docker network create --ignore-existing $netName | Out-Null

# 1. Build the three business projects on the host. The compose file
# bind-mounts the output bin/Debug/net10.0 directories.
Write-Host "Building catalog and gateway ..."
& dotnet build (Join-Path $scriptDir '..\ms2-plans-and-recipes-catalog\src\Catalog.WebApi\Catalog.WebApi.csproj') -c Debug | Out-Null
& dotnet build (Join-Path $scriptDir '..\ms2-plans-and-recipes-catalog\src\Catalog.WorkerService\Catalog.WorkerService.csproj') -c Debug | Out-Null
& dotnet build (Join-Path $scriptDir '..\ms2-plans-and-recipes-catalog-api-gateway\ApiGateway.WebApp\ApiGateway.WebApp.csproj') -c Debug | Out-Null

# 2. Bring up the entire stack in one shot: infra + 3 business processes.
Write-Host "Starting infra + business processes via docker compose ..."
docker compose up -d

# 3. Apply the schema against the new Postgres. The data volume is fresh;
# the migration creates the schemas (write, read, outbox) and the tables.
$conn = 'Host=localhost;Port=5433;Database=ms2-plans-and-recipes-catalog;Username=dev-only;Password=dev-only-password'
$env:ConnectionStrings__CatalogDbConnectionString = $conn
$env:ASPNETCORE_ENVIRONMENT                     = 'Development'

$migrateDll = Get-ChildItem -Path (Join-Path $scriptDir '..\ms2-plans-and-recipes-catalog\src\Catalog.WebApi\bin\Debug\net10.0\Catalog.WebApi.dll') | Select-Object -First 1
Write-Host "Applying catalog schema ..."
& dotnet (Join-Path $migrateDll.DirectoryName 'Catalog.WebApi.dll') --migrate
if ($LASTEXITCODE -ne 0) { throw "Catalog schema migration failed" }

Write-Host ""
Write-Host "Stack ready."
Write-Host "  - Consul UI:    http://localhost:8500"
Write-Host "  - RabbitMQ UI:  http://localhost:15672  (catalogUser / catalogUserPassword)"
Write-Host "  - Gateway:      http://localhost:15005"
Write-Host "  - WebApi:       internal only (reachable through the gateway as /api/catalog/...)"
Write-Host ""
Write-Host "Test the gateway with:"
Write-Host "  curl http://localhost:15005/api/catalog/v1/foods"
Write-Host ""
Write-Host "View tail of a service log with:"
Write-Host "  docker logs -f ms2-plans-and-recipes-catalog-catalog-webapi"
