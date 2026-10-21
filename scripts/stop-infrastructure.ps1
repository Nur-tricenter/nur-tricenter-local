# =============================================================================
#  stop-infrastructure.ps1
#  Stops and removes the three infra containers. The postgres volume is
#  kept by default; pass -v to also drop it.
#
#    ./stop-infrastructure.ps1        # keeps the data
#    ./stop-infrastructure.ps1 -v     # also drops the volume
# =============================================================================

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$composeInfraFile = Join-Path (Split-Path -Parent $scriptDir) 'compose\docker-compose.infra.yml'
$composeArgs = @('-f', $composeInfraFile, 'down')
if ($args -contains '-v') { $composeArgs += '--volumes' }

docker compose @composeArgs
