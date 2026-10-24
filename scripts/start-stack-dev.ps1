# =============================================================================
#  start-stack-dev.ps1
#
#  Same first steps as start-stack.ps1 (build the three business projects
#  against the platform, run schema migrations), but on the docker compose
#  bring-up step it layers docker-compose.dev.yml on top of the base files so
#  the catalog exposes its OpenAPI document on the workstation at
#  http://localhost:18080/swagger.
#
#  Two scripts, one mental model:
#
#    start-stack.ps1         -> base compose.       Swagger OFF, port 18080 unmapped.
#    start-stack-dev.ps1     -> base + dev profile. Swagger ON, port 18080 mapped.
#
#  Application traffic still flows through the gateway at :15005 regardless.
#  The dev-only host port exists only so a developer can read the contract in
#  a browser without `docker exec` or port forwarding tricks.
#
#  The two scripts share the same opening build/migration lines. When you
#  change the shared parts, mirror the change in both. The bring-up step is
#  the only one that differs.
#
#  Layout reminder:
#    scripts/             -> this file
#    ../compose/          -> docker-compose.yml + docker-compose.infra.yml
#    ../compose/dev/      -> docker-compose.dev.yml
#    ../topology/         -> rabbitmq topology + postgres init scripts
#    ../../<sibling>      -> catalog and api-gateway repos live beside this one
# =============================================================================

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
Set-Location $scriptDir

$repoRoot          = Split-Path -Parent $scriptDir
$composeDir        = Join-Path $repoRoot 'compose'
$devComposeDir     = Join-Path $composeDir 'dev'
$composeFile       = Join-Path $composeDir  'docker-compose.yml'
$composeInfraFile  = Join-Path $composeDir  'docker-compose.infra.yml'
$composeDevFile    = Join-Path $devComposeDir 'docker-compose.dev.yml'
$catalogRoot       = Join-Path $repoRoot '..\ms2-plans-and-recipes-catalog'
$gatewayRoot       = Join-Path $repoRoot '..\nur-tricenter-api-gateway'
$ms3Root           = Join-Path $repoRoot '..\ms3-contract-and-production'

# ---- 0. Stale containers ----
# (Same intent as start-stack.ps1: any container squatting the names we want
# forces `docker compose up` to fail. We reuse the same list, mirrored.)
$expected = @(
    'nur-tricenter-postgres','nur-tricenter-rabbitmq','nur-tricenter-consul',
    'nur-tricenter-catalog-api','nur-tricenter-catalog-workerservice',
    'nur-tricenter-contracting-api','nur-tricenter-contracting-workerservice',
    'nur-tricenter-gateway'
)
foreach ($name in $expected) {
    $existing = docker ps -a --filter "name=^${name}$" --format '{{.Names}}' | Select-Object -First 1
    if ($existing) {
        Write-Host "Removing existing container $name (volumes are preserved)"
        docker rm -f $name | Out-Null
    }
}

# ---- 0.5 Platform network ----
# Same idempotent network creation as the base script. Inspect-then-create so
# Docker 29.x (which dropped --ignore-existing) is happy.
$netName = 'nur-tricenter-net'
$existingNet = docker network ls --filter "name=^${netName}$" --format '{{.Name}}' | Select-Object -First 1
if (-not $existingNet) {
    docker network create $netName | Out-Null
}

# ---- 1. Host-side build ----
# Same three projects, same Debug config. The dev profile does not change
# anything about the .NET compilation; it only flips a runtime env var on
# one container.
Write-Host "Building catalog and gateway ..."
& dotnet build (Join-Path $catalogRoot 'src\Catalog.App\Catalog.App.csproj')              -c Debug | Out-Null
& dotnet build (Join-Path $catalogRoot 'src\Catalog.WorkerService\Catalog.WorkerService.csproj') -c Debug | Out-Null
& dotnet build (Join-Path $gatewayRoot 'ApiGateway.App\ApiGateway.App.csproj')            -c Debug | Out-Null
& dotnet build (Join-Path $ms3Root 'Nurtricenter.Api\Nurtricenter.MS3.Api.csproj')                         -c Debug | Out-Null
& dotnet build (Join-Path $ms3Root 'Nurtricenter.MS3.WorkerService\Nurtricenter.MS3.WorkerService.csproj') -c Debug | Out-Null

# ---- 2. Infra + business processes ----
# THIS is the line that deviates from the base script: layer the dev profile
# on top. All other services and the infra come from the base compose files.
Write-Host "Starting infra + business processes (dev profile) ..."
docker compose `
    -f $composeFile `
    -f $composeInfraFile `
    -f $composeDevFile `
    -p nur-tricenter up -d

if ($LASTEXITCODE -ne 0) { throw "docker compose up (dev profile) failed" }

# ---- 3. Schema migration ----
# Same idempotent migration the base script runs. The catalog-api container
# also migrates on boot (Migrations__ApplyOnStartup=true). This belt-and-
# suspenders run makes the schema visible to other tools before any
# container restart.
$conn = 'Host=localhost;Port=5433;Database=ms2-plans-and-recipes-catalog;Username=dev-only;Password=dev-only-password'
$env:ConnectionStrings__CatalogDbConnectionString = $conn
$env:ASPNETCORE_ENVIRONMENT                     = 'Development'

$migrateDll = Get-ChildItem -Path (Join-Path $catalogRoot 'src\Catalog.App\bin\Debug\net8.0\Catalog.App.dll') | Select-Object -First 1
Write-Host "Applying catalog schema ..."
& dotnet (Join-Path $migrateDll.DirectoryName 'Catalog.App.dll') --migrate
if ($LASTEXITCODE -ne 0) { throw "Catalog schema migration failed" }

Write-Host ""
Write-Host "Dev stack ready."
Write-Host "  - Consul UI:           http://localhost:8500"
Write-Host "  - RabbitMQ UI:         http://localhost:15672  (guest / guest)"
Write-Host "  - Gateway:             http://localhost:15005"
Write-Host "  - Catalog Swagger UI:  http://localhost:18080/swagger"
Write-Host "  - Catalog Swagger doc: http://localhost:18080/swagger/v1/swagger.json"
Write-Host ""
Write-Host "  Application traffic still goes through the gateway. The :18080 host port"
Write-Host "  is a dev-only convenience for reading the contract in a browser."
Write-Host ""
Write-Host "Test the gateway with:"
Write-Host "  curl http://localhost:15005/api/catalog/v1/foods"
Write-Host ""
Write-Host "Tail a service log with:"
Write-Host "  docker logs -f nur-tricenter-catalog-api"
