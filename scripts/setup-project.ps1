# =============================================================================
#  setup-project.ps1
#  Clones the repositories the platform needs, as siblings of this one.
#
#    .\scripts\setup-project.ps1
#
#  WHY THIS EXISTS
#
#  The stack is one orchestrator plus four microservices, and compose reaches into
#  each of them with a relative path:
#
#    - path: ../ms2-plans-and-recipes-catalog/catalog.compose.yml
#    - ../nur-tricenter-identity/identity.compose.yml
#    - ../../nur-tricenter-api-gateway/ApiGateway.App/bin/...:/app:ro
#
#  Those paths assume the repositories are SIBLINGS. Cloning the orchestrator on
#  its own therefore produces a stack that cannot start, and the error says
#  nothing about the missing directories — it reads as a compose syntax problem.
#
#  This script makes that assumption explicit and reproducible: clone once, here,
#  and every other script works from the layout they already expect.
#
#  IDEMPOTENT. A repository already present is left untouched, so re-running
#  after pulling one microservice's changes is safe and does not discard work.
#
#  Layout produced:
#
#    <workspace>/
#      ANALISIS-ARQUITECTURA-MS2026.md
#      nur-tricenter-orchestrator/     <- you are here
#      ms2-plans-and-recipes-catalog/
#      nur-tricenter-identity/
#      nur-tricenter-api-gateway/
#      nur-tricenter-shared-kernels/
# =============================================================================

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
$workspace = Split-Path -Parent $repoRoot

# The repository the orchestrator itself lives in, so a clone of that one updates
# rather than fighting the clone for the same directory.
$selfRepo = 'https://github.com/Nur-tricenter/nur-tricenter-local.git'

$repositories = @(
    @{ Name = 'ms1-clinica-nutricional'; Url = 'https://github.com/Juandcode/ClinicaNutricionalMicroservicio1.git' }
    @{ Name = 'ms2-plans-and-recipes-catalog'; Url = 'https://github.com/Nur-tricenter/ms2-plans-and-recipes-catalog.git' }
    @{ Name = 'nur-tricenter-identity';         Url = 'https://github.com/Nur-tricenter/nur-tricenter-identity.git' }
    @{ Name = 'nur-tricenter-api-gateway';       Url = 'https://github.com/Nur-tricenter/nur-tricenter-api-gateway.git' }
    @{ Name = 'nur-tricenter-shared-kernels';    Url = 'https://github.com/Nur-tricenter/nur-tricenter-shared-kernels.git' }
    @{ Name = 'ms5-logistics-and-delivery';     Url = 'https://github.com/Nur-tricenter/ms5-logistics-and-delivery.git' }
    @{ Name = 'ms4-delivery-schedule-management'; Url = 'https://github.com/Nur-tricenter/ms4-delivery-schedule-management.git' }
    @{ Name = 'ms3-contract-and-production'; Url = 'https://github.com/Nur-tricenter/ms3-contract-and-production.git' }
)

Write-Host ''
Write-Host 'Nur-Tricenter workspace setup' -ForegroundColor Cyan
Write-Host "  workspace: $workspace"
Write-Host ''

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git is not on PATH. Install it from https://git-scm.com/downloads and run this script again."
}

$cloned = 0
$present = 0

foreach ($repo in $repositories) {
    $target = Join-Path $workspace $repo.Name

    if (Test-Path (Join-Path $target '.git')) {
        Write-Host "  ya existe   $($repo.Name)" -ForegroundColor DarkGray
        $present++
        continue
    }

    # A directory with the right name but no .git means something else is in the way.
    # Cloning into it would either fail or produce a nested tree, so stop and say why.
    if (Test-Path $target) {
        throw "$($repo.Name) already exists at $target but is not a git repository. Move it aside, then run this again."
    }

    Write-Host "  clonando    $($repo.Name) ..." -ForegroundColor Yellow
    & git clone --quiet $repo.Url $target

    if ($LASTEXITCODE -ne 0) {
        throw "git clone failed for $($repo.Name). Check network access and that you can reach the repository."
    }

    Write-Host "  listo       $($repo.Name)" -ForegroundColor Green
    $cloned++
}

Write-Host ''
Write-Host "  $cloned clonado(s), $present ya estaban." -ForegroundColor Cyan

if ($cloned -eq 0 -and $present -eq $repositories.Count) {
    Write-Host ''
    Write-Host '  Nada que hacer: el workspace ya estaba completo.'
    exit 0
}

# --- Credentials ------------------------------------------------------------
# The platform kernels are private packages on GitHub Packages, so a restore
# needs a personal access token WITH read:packages (and write:packages if you
# intend to publish a kernel yourself).
#
# Reported, never created: generating a token is a decision about YOUR account,
# and a script that can mint credentials should not. GitHub also will not let it.
$username = [Environment]::GetEnvironmentVariable('NUGET_USERNAME', 'User')
$token    = [Environment]::GetEnvironmentVariable('NUGET_TOKEN', 'User')

Write-Host ''
Write-Host '  Credenciales del feed privado' -ForegroundColor Cyan

if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host '    NUGET_TOKEN no esta definida en tu perfil de usuario.' -ForegroundColor Yellow
    Write-Host '    Creala con (GitHub > Settings > Developer settings >' -ForegroundColor DarkGray
    Write-Host '    Personal access tokens > Fine-grained > read:packages):' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '      [Environment]::SetEnvironmentVariable("NUGET_USERNAME", "tu-usuario", "User")' -ForegroundColor DarkGray
    Write-Host '      [Environment]::SetEnvironmentVariable("NUGET_TOKEN",   "tu-token",    "User")' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '    Abri una terminal nueva: las variables recien设置的 no se ven en esta.' -ForegroundColor DarkGray
}
else {
    Write-Host "    NUGET_TOKEN definida para '$username'." -ForegroundColor Green
}

Write-Host ''
Write-Host '  Siguiente paso:' -ForegroundColor Cyan
Write-Host '    .\scripts\start-stack.ps1' -ForegroundColor Gray
Write-Host ''