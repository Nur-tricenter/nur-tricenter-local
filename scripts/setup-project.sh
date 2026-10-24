#!/usr/bin/env bash
# =============================================================================
#  setup-project.sh
#  Clones the repositories the platform needs, as siblings of this one.
#
#    ./scripts/setup-project.sh
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

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "$script_dir")"
workspace="$(dirname "$repo_root")"

repositories=(
  "ms2-plans-and-recipes-catalog|https://github.com/Nur-tricenter/ms2-plans-and-recipes-catalog.git"
  "nur-tricenter-identity|https://github.com/Nur-tricenter/nur-tricenter-identity.git"
  "nur-tricenter-api-gateway|https://github.com/Nur-tricenter/nur-tricenter-api-gateway.git"
  "nur-tricenter-shared-kernels|https://github.com/Nur-tricenter/nur-tricenter-shared-kernels.git"
  "nurtricenter-logistics-and-delivery|https://github.com/DruGuerrero/nurtricenter-logistics-and-delivery.git"
  "delivery-schedule-management|https://github.com/nur-university/modulo-2-actividad-3-franklin-andre.git"
)

echo
echo "Nur-Tricenter workspace setup"
echo "  workspace: $workspace"
echo

if ! command -v git >/dev/null 2>&1; then
  echo "error: git is not on PATH. Install it and run this script again." >&2
  exit 1
fi

cloned=0
present=0

for entry in "${repositories[@]}"; do
  name="${entry%%|*}"
  url="${entry#*|}"
  target="$workspace/$name"

  if [ -d "$target/.git" ]; then
    echo "  ya existe   $name"
    present=$((present + 1))
    continue
  fi

  # A directory with the right name but no .git means something else is in the
  # way. Cloning into it would either fail or produce a nested tree.
  if [ -e "$target" ]; then
    echo "error: $name already exists at $target but is not a git repository." >&2
    echo "       Move it aside, then run this again." >&2
    exit 1
  fi

  echo "  clonando    $name ..."
  git clone --quiet "$url" "$target"
  echo "  listo       $name"
  cloned=$((cloned + 1))
done

echo
echo "  $cloned clonado(s), $present ya estaban."

if [ "$cloned" -eq 0 ] && [ "$present" -eq "${#repositories[@]}" ]; then
  echo
  echo "  Nada que hacer: el workspace ya estaba completo."
  exit 0
fi

# --- Credentials ------------------------------------------------------------
# The platform kernels are private packages on GitHub Packages, so a restore
# needs a personal access token WITH read:packages (and write:packages if you
# intend to publish a kernel yourself).
#
# Reported, never created: generating a token is a decision about YOUR account,
# and a script that can mint credentials should not. GitHub also will not let it.
echo
echo "  Credenciales del feed privado"

if [ -z "${NUGET_TOKEN:-}" ]; then
  echo "    NUGET_TOKEN no esta definida en tu perfil."
  echo "    Creala con (GitHub > Settings > Developer settings >"
  echo "    Personal access tokens > Fine-grained > read:packages):"
  echo
  echo '      export NUGET_USERNAME="tu-usuario"'
  echo '      export NUGET_TOKEN="tu-token"'
  echo
  echo "    El nombre de la variable es el mismo en los cuatro repos: NUGET_TOKEN."
else
  echo "    NUGET_TOKEN esta definida."
fi

echo
echo "  Siguiente paso:"
echo "    ./scripts/start-stack.sh"
echo