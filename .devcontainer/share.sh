#!/usr/bin/env bash
# Gives the platform public https addresses so people outside the codespace can use it, through
# Cloudflare quick tunnels (*.trycloudflare.com; no account, no fixed name). See README.md.
#
#   bash .devcontainer/share.sh on    open the tunnels, switch the apps to them, restart the apps
#   bash .devcontainer/share.sh off   close the tunnels and go back to the *.localhost addresses
#   bash .devcontainer/share.sh urls  print the current addresses
#
# Why not the codespace's own *.app.github.dev links: the Codespaces proxy hands the app
# `Host: localhost` and rewrites the browser's Origin to http://localhost:<port>, so the panels
# cannot tell which host was asked for and refuse the sign-in as cross-site. A quick tunnel passes
# Host, Origin and the visitor's address (cf-connecting-ip) through unchanged.
#
# While sharing is on, .devcontainer/start.sh opens new tunnels on every start: the addresses
# change after each restart of the codespace. Mailpit stays private (it holds every sign-in code).
set -euo pipefail
umask 022
cd "$(dirname "$0")/.."

SHARE=.local/share
LOGS=.local/logs
MARKET="${MARKET:-AU}"
mkdir -p "$SHARE" "$LOGS"

stop_tunnels() {
  for pidfile in "$SHARE"/tunnel-*.pid; do
    [ -f "$pidfile" ] || continue
    kill -TERM -- "-$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
  done
}

ensure_cloudflared() {
  command -v cloudflared >/dev/null && return
  echo "Installing cloudflared from Cloudflare's signed apt repository"
  sudo mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg |
    sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(. /etc/os-release && echo "$VERSION_CODENAME") main" |
    sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq cloudflared
}

# Opens a quick tunnel to a local port and prints its https origin.
open_tunnel() {
  local name="$1" port="$2" log="$LOGS/tunnel-$1.log"
  setsid nohup cloudflared tunnel --no-autoupdate --url "http://localhost:$port" \
    >"$log" 2>&1 </dev/null &
  echo $! >"$SHARE/tunnel-$name.pid"
  local url=""
  for _ in $(seq 1 60); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -n 1 || true)"
    [ -n "$url" ] && break
    sleep 1
  done
  if [ -z "$url" ]; then
    echo "The $name tunnel did not open; see $log" >&2
    return 1
  fi
  echo "$url"
}

secret() { node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"; }

share_on() {
  ensure_cloudflared
  bash .devcontainer/stop.sh >/dev/null
  stop_tunnels

  echo "Opening the tunnels (about 10 seconds each)"
  local seller admin web api
  seller="$(open_tunnel seller 3001)"
  admin="$(open_tunnel admin 3002)"
  web="$(open_tunnel web 3003)"
  api="$(open_tunnel api 3000)"

  # The panels and the buyer site call the API on this container's own network address, not on
  # localhost, so only their calls come from TRUSTED_BFF_CIDRS and must carry the signed client
  # address (ADR-0037). Everything else on localhost (the demo seed, curl) stays an ordinary
  # client. The tunnel reaches the apps from localhost: that is the edge the apps trust for
  # cf-connecting-ip.
  local ip
  ip="$(hostname -I | awk '{print $1}')"
  local seller_secret admin_secret web_secret
  seller_secret="$(secret)"
  admin_secret="$(secret)"
  web_secret="$(secret)"

  # Quoted: the entries are separated by ";", and start.sh reads these files with the shell.
  cat >"$SHARE/api.env" <<ENV
TRUSTED_BFF_CIDRS=$ip/32
CLIENT_ADDRESS_KEYS='panel-seller:$ip/32:$seller_secret;panel-admin:$ip/32:$admin_secret;storefront:$ip/32:$web_secret'
ENV
  local edge="CLIENT_ADDRESS_SOURCE=edge
EDGE_CIDRS=127.0.0.1/32
EDGE_CLIENT_ADDRESS_HEADER=cf-connecting-ip
API_BASE_URL=http://$ip:3000"
  printf '%s\nPANEL_HOSTS=%s=%s\nBFF_CLIENT_ADDRESS_KEY_ID=panel-seller\nBFF_CLIENT_ADDRESS_SECRET=%s\nPANEL_STOREFRONT_ADDRESS=%s/shop/\n' \
    "$edge" "$seller" "$MARKET" "$seller_secret" "${web#https://}" >"$SHARE/seller.env"
  printf '%s\nPANEL_HOSTS=%s=%s\nBFF_CLIENT_ADDRESS_KEY_ID=panel-admin\nBFF_CLIENT_ADDRESS_SECRET=%s\n' \
    "$edge" "$admin" "$MARKET" "$admin_secret" >"$SHARE/admin.env"
  printf '%s\nSTOREFRONT_HOSTS=%s=%s\nSTOREFRONT_IMAGE_ORIGIN=%s\nSELLER_SIGN_IN_URLS=%s=%s/sign-in\nBFF_CLIENT_ADDRESS_KEY_ID=storefront\nBFF_CLIENT_ADDRESS_SECRET=%s\n' \
    "$edge" "$web" "$MARKET" "$api" "$MARKET" "$seller" "$web_secret" >"$SHARE/web.env"
  chmod 600 "$SHARE"/*.env

  # Mail links and allowed origins of the local Market config point at the tunnels.
  SELLER_PANEL_ORIGIN="$seller" ADMIN_PANEL_ORIGIN="$admin" STOREFRONT_ORIGIN="$web" \
    node scripts/dev-panels-market.mjs "$MARKET" >/dev/null

  printf 'Seller panel : %s\nAdmin panel  : %s\nBuyer site   : %s\nAPI          : %s\n' \
    "$seller" "$admin" "$web" "$api" >"$SHARE/urls.txt"
  touch "$SHARE/enabled"
  SHARE_TUNNELS_OPEN=1 bash .devcontainer/start.sh >/dev/null
  echo
  echo "Shared. Send these addresses to the team (they change when the codespace restarts):"
  cat "$SHARE/urls.txt"
  echo "The apps need about a minute to start (the API builds first)."
}

share_off() {
  bash .devcontainer/stop.sh >/dev/null
  stop_tunnels
  rm -f "$SHARE/enabled" "$SHARE"/*.env "$SHARE/urls.txt"
  STOREFRONT_ORIGIN=http://storefront.localhost:3003 node scripts/dev-panels-market.mjs "$MARKET" >/dev/null
  bash .devcontainer/start.sh
}

case "${1:-}" in
  on) share_on ;;
  off) share_off ;;
  urls) if [ -f "$SHARE/enabled" ]; then cat "$SHARE/urls.txt"; else echo "Sharing is off."; fi ;;
  *)
    echo "usage: bash .devcontainer/share.sh on|off|urls" >&2
    exit 1
    ;;
esac
