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
$ms1Root           = Join-Path $repoRoot '..\ms1-gestion-clinica-nutricional'
$ms4Root           = Join-Path $repoRoot '..\ms4-delivery-schedule-management'
$ms3Root           = Join-Path $repoRoot '..\ms3-contract-and-production'
# ms5's folder name differs between clones; the compose include reads the same variable.
$nurtricenterDir   = if ($env:NURTRICENTER_REPO_DIR) { $env:NURTRICENTER_REPO_DIR } else { 'ms5-logistics-and-delivery' }
$nurtricenterRoot  = Join-Path $repoRoot "..\$nurtricenterDir"

# 0. Make sure no stale containers are squatting the names we need. Same
# pattern as start-infrastructure.ps1: rm first, then up. The named
# volumes survive.
$expected = @(
    # Platform
    'nur-tricenter-postgres','nur-tricenter-rabbitmq','nur-tricenter-consul',
    # Microservice processes (container_name declared in docker-compose.yml)
    'nur-tricenter-clinica-nutricional-migrate','nur-tricenter-clinica-nutricional-api','nur-tricenter-clinica-nutricional-workerservice',
    'nur-tricenter-catalog-api','nur-tricenter-catalog-workerservice',
    'nur-tricenter-identity-migrate','nur-tricenter-identity-api','nur-tricenter-identity-workerservice',
    'nur-tricenter-delivery-calendar-migrate','nur-tricenter-delivery-calendar-api','nur-tricenter-delivery-calendar-workerservice',
    'nur-tricenter-nurtricenter-migrate','nur-tricenter-nurtricenter-api','nur-tricenter-nurtricenter-workerservice',
    'nur-tricenter-contracting-api','nur-tricenter-contracting-workerservice',
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
# Every build is checked: a failed build used to surface only as a container that never started.
Write-Host "Building catalog, identity, ms5, gateway, clinica nutricional (ms1), delivery calendar (ms4) and contracting (ms3) ..."
$projects = @(
    (Join-Path $catalogRoot 'src\Catalog.App\Catalog.App.csproj'),
    (Join-Path $catalogRoot 'src\Catalog.WorkerService\Catalog.WorkerService.csproj'),
    (Join-Path $identityRoot 'src\Identity.App\Identity.App.csproj'),
    (Join-Path $identityRoot 'src\Identity.WorkerService\Identity.WorkerService.csproj'),
    (Join-Path $nurtricenterRoot 'src\Nurtricenter.Api\Nurtricenter.Api.csproj'),
    (Join-Path $nurtricenterRoot 'src\Nurtricenter.WorkerService\Nurtricenter.WorkerService.csproj'),
    (Join-Path $gatewayRoot 'ApiGateway.App\ApiGateway.App.csproj'),
    # MS1 builds into its own bin\Debug\net10.0 folders, which ms1.compose.yml bind-mounts.
    (Join-Path $ms1Root 'GestionClinicaNutricionalService.WebApi\GestionClinicaNutricionalService.WebApi.csproj'),
    (Join-Path $ms1Root 'GestionClinicaNutricional.WorkerService\GestionClinicaNutricional.WorkerService.csproj'),
    # MS4 builds into its own artifacts\ folder (ArtifactsPath), which ms4.compose.yml bind-mounts.
    (Join-Path $ms4Root 'src\Api\Api.csproj'),
    (Join-Path $ms4Root 'src\WorkerService\WorkerService.csproj'),
    (Join-Path $ms3Root 'Nurtricenter.Api\Nurtricenter.MS3.Api.csproj'),
    (Join-Path $ms3Root 'Nurtricenter.MS3.WorkerService\Nurtricenter.MS3.WorkerService.csproj')
)
foreach ($project in $projects) {
    & dotnet build $project -c Debug | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $project" }
}

# 2. Bring up infra + business processes in one shot. docker compose writes
# informational lines to stderr, which with $ErrorActionPreference='Stop' would
# abort the script even on a successful up. Run it with the preference relaxed
# and discard its output; the exit code is what matters.
#
# Infra goes first, then every database is ensured. Postgres runs postgres-init\ only on a
# brand-new volume, so a volume created before a service was added lacks its database and
# that service's migrate job fails. The script is idempotent (CREATE only when missing).
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
Write-Host "Starting infra (postgres, rabbitmq, consul) ..."
docker compose -f $composeInfraFile -p nur-tricenter up -d --wait 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $previousErrorAction; throw "infra did not become healthy" }
Write-Host "Ensuring every service database exists ..."
docker exec nur-tricenter-postgres psql -q -U dev-only -d postgres -f /docker-entrypoint-initdb.d/01-create-databases.sql 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $previousErrorAction; throw "could not create the service databases" }
Write-Host "Starting business processes via docker compose ..."
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

# 4. MS4's service account. MS4 reads meal plans from the catalog (catalog.mealPlan:read) as a
# service account, not as the administrator. Identity seeds no such account, so it is created
# here through the gateway with the seeded admin's token. Idempotent: 409 means it exists.
# The gateway learns identity's route from Consul within ~30s, hence the retry loop.
$gateway = 'http://localhost:15005'
$adminToken = $null
for ($attempt = 1; $attempt -le 24 -and -not $adminToken; $attempt++) {
    try {
        $login = Invoke-RestMethod -Method Post -Uri "$gateway/api/identity-service/v1/auth/login" `
            -ContentType 'application/json' -Body '{"userName":"admin","password":"admin"}'
        $adminToken = $login.accessToken
    } catch {
        Start-Sleep -Seconds 5
    }
}
if (-not $adminToken) { throw "Could not log in to identity through the gateway to create MS4's service account" }

$serviceAccount = @{
    userName = 'ms4-service'
    email    = 'ms4-service@nur.local'
    password = 'dev-only-ms4-service-password'
    scopes   = @('catalog.mealPlan:read')
} | ConvertTo-Json
try {
    Invoke-RestMethod -Method Post -Uri "$gateway/api/identity-service/v1/users" `
        -Headers @{ Authorization = "Bearer $adminToken" } -ContentType 'application/json' -Body $serviceAccount | Out-Null
    Write-Host "Created MS4 service account 'ms4-service'."
} catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 409) {
        Write-Host "MS4 service account 'ms4-service' already exists."
    } else {
        throw
    }
}
# MS3's service account: MS3 calls MS4 to create the delivery calendar after a payment
# (deliveryCalendar.calendar:create) and to read tomorrow's production order
# (deliveryCalendar.productionOrder:read). Same idempotent creation as MS4's.
$ms3ServiceAccount = @{
    userName = 'ms3-service'
    email    = 'ms3-service@nur.local'
    password = 'dev-only-ms3-service-password'
    scopes   = @('deliveryCalendar.calendar:create', 'deliveryCalendar.productionOrder:read')
} | ConvertTo-Json
try {
    Invoke-RestMethod -Method Post -Uri "$gateway/api/identity-service/v1/users" `
        -Headers @{ Authorization = "Bearer $adminToken" } -ContentType 'application/json' -Body $ms3ServiceAccount | Out-Null
    Write-Host "Created MS3 service account 'ms3-service'."
} catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 409) {
        Write-Host "MS3 service account 'ms3-service' already exists."
    } else {
        throw
    }
}

Write-Host ""
Write-Host "Stack ready."
Write-Host "  - Consul UI:    http://localhost:8500"
Write-Host "  - RabbitMQ UI:  http://localhost:15672  (guest / guest)"
Write-Host "  - Gateway:      http://localhost:15005"
Write-Host "  - Catalog API:   internal only (reachable through the gateway as /api/catalog/v1/...)"
Write-Host "  - Clinica nutricional (ms1): internal only (through the gateway as /api/clinica-nutricional/v1/...)"
Write-Host "  - Delivery calendar (ms4): internal only (through the gateway as /api/delivery-calendar/v1/...)"
Write-Host "  - ms5 API:       internal only (reachable through the gateway as /api/nurtricenter/v1/...)"
Write-Host "    (database: ConnectionStrings__DefaultConnection in $nurtricenterRoot\.env; its schema is applied by the nurtricenter-migrate job)"
Write-Host ""
Write-Host "Test the gateway with:"
Write-Host "  curl http://localhost:15005/api/catalog/v1/foods"
Write-Host ""
Write-Host "View tail of a service log with:"
Write-Host "  docker logs -f nur-tricenter-catalog-api"
