#!/usr/bin/env bash
# Starts the API, the worker, the seller and admin panels and the buyer site in the background,
# like scripts/dev-local.bat steps 4 and 5. Runs on every codespace start; safe to run again
# (a process that is already running is left alone). Logs: .local/logs/<name>.log
# Stop everything: bash .devcontainer/stop.sh
set -euo pipefail
umask 022
cd "$(dirname "$0")/.."

LOGS=.local/logs
mkdir -p "$LOGS"
export MARKET_CONFIG_DIR="$PWD/.local/markets"
export SERVICE_AREA_CONFIG_DIR="$PWD/.local/service-areas"

if [ ! -d node_modules ] || [ ! -f "$MARKET_CONFIG_DIR/AU.json" ]; then
  echo "Setup has not finished; running .devcontainer/setup.sh first"
  bash .devcontainer/setup.sh
fi

launch() {
  local name="$1"
  shift
  local pidfile="$LOGS/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name is already running (pid $(cat "$pidfile"))"
    return
  fi
  setsid nohup "$@" >"$LOGS/$name.log" 2>&1 </dev/null &
  echo $! >"$pidfile"
  echo "started $name (log: $LOGS/$name.log)"
}

launch api pnpm dev
launch seller pnpm dev:seller
launch admin pnpm dev:admin
launch web pnpm dev:web
# The worker builds the API once; start it after the API is up so it does not race the API
# watcher that cleans dist (as dev-local.bat does).
launch worker bash -c 'for i in $(seq 1 120); do curl -sf -m 3 -o /dev/null http://localhost:3000/health && break; sleep 5; done; exec pnpm dev:worker'

cat <<'TEXT'

The apps are starting (the API needs about a minute to build).
Open them through the forwarded ports, see .devcontainer/README.md:
  Seller panel : http://seller.localhost:3001
  Admin panel  : http://admin.localhost:3002
  Buyer site   : http://storefront.localhost:3003  (or http://localhost:3003)
  API          : http://localhost:3000/health   (Swagger: /docs)
  Mailpit      : http://localhost:8025
TEXT
