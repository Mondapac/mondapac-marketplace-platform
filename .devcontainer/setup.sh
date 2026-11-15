#!/usr/bin/env bash
# Runs once when the codespace (dev container) is created. Linux twin of scripts/dev-local.bat
# steps 1 to 3: .env files, packages, migrations and the local Market configuration.
# Safe to run again by hand: `bash .devcontainer/setup.sh`.
set -euo pipefail
# Native addons (SWC) refuse a cache folder that other users can write to.
umask 022
cd "$(dirname "$0")/.."

MARKET="${MARKET:-AU}"
export STOREFRONT_ORIGIN="${STOREFRONT_ORIGIN:-http://storefront.localhost:3003}"

copy_if_missing() {
  if [ ! -f "$2" ]; then
    echo "Creating $2 from $1"
    cp "$1" "$2"
  fi
}
copy_if_missing .env.example .env
copy_if_missing apps/seller/.env.example apps/seller/.env.local
copy_if_missing apps/admin/.env.example apps/admin/.env.local
# The buyer site's defaults: sample data only (API_BASE_URL empty), as in scripts/dev-local.bat.
copy_if_missing apps/web/.env.example apps/web/.env.local

echo "[1/3] Installing packages"
sudo corepack enable
corepack install
# Keep the package store next to the repository (same disk, so pnpm can hard-link) but
# outside it, so it never shows up in git status.
sudo mkdir -p /workspaces/.pnpm-store
sudo chown "$(id -u):$(id -g)" /workspaces/.pnpm-store
pnpm install --frozen-lockfile --store-dir /workspaces/.pnpm-store

echo "[2/3] Applying migrations"
# The `postgres` service is healthy before this container starts (compose depends_on).
set -a
# shellcheck disable=SC1091
. ./.env
set +a
pnpm db:migrate

echo "[3/3] Writing the local Market configuration for ${MARKET}"
node scripts/dev-panels-market.mjs "$MARKET"

echo "Setup done. .devcontainer/start.sh starts the apps (it runs on every codespace start)."
