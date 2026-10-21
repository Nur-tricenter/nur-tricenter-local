# =============================================================================
#  start-infrastructure.ps1
#  Brings up the three platform containers (Postgres + RabbitMQ + Consul)
#  on the nur-tricenter-net docker network. Microservice processes
#  (catalog-webapi, catalog-workerservice) and the gateway come up
#  separately via start-stack.ps1.
#
#  Idempotent: if the containers are already up and ready, the script
#  reports so and exits 0. Removes any containers under the expected
#  names first so a half-finished session does not block the run; named
#  volumes survive.
#
#  Layout reminder:
#    scripts/         -> this file
#    ../compose/      -> docker-compose.infra.yml (this script uses only this one)
#    ../topology/     -> rabbitmq topology + postgres init scripts
# =============================================================================

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$repoRoot          = Split-Path -Parent $scriptDir
$composeInfraFile  = Join-Path $repoRoot 'compose\docker-compose.infra.yml'

$expected = @('nur-tricenter-postgres','nur-tricenter-rabbitmq','nur-tricenter-consul')
$timeout  = (Get-Date).AddMinutes(2)

# Network: create if missing; the catalog's compose uses the same name.
if (-not (docker network ls --format '{{.Name}}' | Select-String -Quiet -SimpleMatch 'nur-tricenter-net')) {
    Write-Host "Creating network nur-tricenter-net"
    docker network create nur-tricenter-net | Out-Null
}

# Remove any containers that already exist under the expected names. The
# named volumes survive, so the database is preserved.
foreach ($name in $expected) {
    $existing = docker ps -a --filter "name=^${name}$" --format '{{.Names}}' | Select-Object -First 1
    if ($existing) {
        Write-Host "Removing existing container $name (volumes are preserved)"
        docker rm -f $name | Out-Null
    }
}

# Make sure the postgres data volume exists with a name that the compose
# can attach to. If it does not exist yet, `docker compose up` will create
# it. If it exists from a previous run, attach it back to the network
# namespace.
$pgVol = docker volume ls --format '{{.Name}}' | Select-String -Quiet -SimpleMatch 'nur-tricenter-postgres-data'
if (-not $pgVol) {
    Write-Host "Creating volume nur-tricenter-postgres-data"
    docker volume create nur-tricenter-postgres-data | Out-Null
}

Write-Host "Lifting infrastructure from docker-compose.infra.yml ..."
docker compose -f $composeInfraFile up -d | Out-Null

Write-Host -NoNewline "Waiting for readiness "
$ok = 0
while ((Get-Date) -lt $timeout) {
    Start-Sleep -Seconds 2
    $ok = 0
    foreach ($name in $expected) {
        $status = (docker ps --filter "name=^${name}$" --format '{{.Status}}' | Select-Object -First 1)
        if ($null -eq $status) { continue }
        if ($status -match 'healthy' -or ($status -match '^Up\b' -and $status -notmatch '\(unhealthy\)' -and $status -notmatch 'Restarting')) {
            $ok++
        }
    }
    if ($ok -eq $expected.Count) { break }
    Write-Host -NoNewline "."
}
Write-Host ""

if ($ok -lt $expected.Count) {
    $state = docker ps -a --filter "name=^nur-tricenter-" --format '{{.Names}} {{.Status}}'
    throw "Infrastructure not ready within 2 minutes. State:`n$state"
}

Write-Host "Infrastructure ready:"
foreach ($n in $expected) {
    $port = (docker port $n 2>$null) -join ', '
    Write-Host "  - $n  ($port)"
}
