# =============================================================================
#  start-infrastructure.ps1
#  Brings Postgres, RabbitMQ and Consul up under the names the rest of the
#  stack expects (nur-tricenter-postgres / -rabbitmq / -consul).
#
#  SEMANTICS
#  ---------
#  This is the bootstrap step. It is destructive on the container level
#  but PRESERVES the named volumes (postgres-data, etc.). That is the
#  point: when you re-run the script you do not want to lose the database
#  the catalog has been writing to.
#
#  What gets lost across a restart:
#    * Messages currently in queues. catalog.default is non-durable by
#      design (Fase 4 of the catalog), so this is expected and not a
#      concern for the orchestrator end-to-end check.
#    * The Consul agent's in-memory registration cache. Each WebApi
#      re-registers itself in milliseconds on startup, so the gateway
#      sees it again after its next 30s refresh.
#
#  What gets preserved:
#    * All data in the postgres volume (the catalog's seed and any
#      subsequent writes).
#
#  Why not just use `docker compose up -d`? Because the catalog's earlier
#  containers were created by a different compose and share the same
#  names, so `docker compose up` reports a name conflict. The right
#  answer is to remove the old containers first, then bring the new ones
#  up under the same names.
# =============================================================================

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$expected = @('nur-tricenter-postgres','nur-tricenter-rabbitmq','nur-tricenter-consul')
$timeout  = (Get-Date).AddMinutes(2)

# Network: create if missing; the catalog's compose uses the same name.
if (-not (docker network ls --format '{{.Name}}' | Select-String -Quiet -SimpleMatch 'nur-tricenter-net')) {
    Write-Host "Creating network nur-tricenter-net"
    docker network create nur-tricenter-net | Out-Null
}

# Remove any containers that already exist under the expected names. Volumes
# named postgres-data survive this because they are not attached to a
# running container, and `docker rm -f` only affects the container, not
# the volume. We do the same for the two stateless containers for symmetry.
foreach ($name in $expected) {
    $existing = docker ps -a --filter "name=^${name}$" --format '{{.Names}}' | Select-Object -First 1
    if ($existing) {
        Write-Host "Removing existing container $name (volumes are preserved)"
        docker rm -f $name | Out-Null
    }
}

Write-Host "Lifting infrastructure from docker-compose.infra.yml ..."
docker compose -f docker-compose.infra.yml up -d | Out-Null

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
