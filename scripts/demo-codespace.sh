#!/usr/bin/env bash
# The local demo (scripts/dev-local.bat) inside a GitHub Codespace: Docker services, migrations,
# the API, the worker, both panels and the buyer site, each in the background with its log in
# .local/logs/. Panel and buyer-site hosts are the Codespace's forwarded https addresses, so the
# Market file under .local/markets allows exactly those origins.
#
#   bash scripts/demo-codespace.sh          # start
#   bash scripts/demo-codespace.sh seed     # start, then fill the sample marketplace (idempotent)
#
# Stripe stays in test mode. Keys come only from Codespaces secrets, are passed to the processes'
# environment and are never written to a file: SK_TEST (sk_test_), PK_TEST (pk_test_),
# WHSEC_TEST (the platform webhook endpoint's whsec_) and WHSEC_CONNECT_TEST (the Connect one).
# Each is optional; without it that part of Stripe stays off, as in the local demo.
#
# Port 3000 (the API) is made public so Stripe can deliver webhooks to
# <API address>/payments/stripe/webhook/AU. The other ports stay private: only the Codespace's
# owner, signed in to GitHub, can open them.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CODESPACE_NAME:?run this inside a GitHub Codespace}"
domain="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
address() { echo "https://${CODESPACE_NAME}-$1.${domain}"; }
API_ADDRESS="$(address 3000)"
export SELLER_PANEL_ORIGIN="$(address 3001)"
export ADMIN_PANEL_ORIGIN="$(address 3002)"
export STOREFRONT_ORIGIN="$(address 3003)"
MARKET=AU
LOGS=.local/logs
mkdir -p "$LOGS"

# KEY=value in an env file: replaced when present, appended when not.
set_env() {
  local file=$1 key=$2 value=$3
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" >> "$file"
  fi
}

[ -f .env ] || cp .env.example .env
for app in seller admin web; do
  [ -f "apps/$app/.env.local" ] || cp "apps/$app/.env.example" "apps/$app/.env.local"
done
set_env apps/seller/.env.local PANEL_HOSTS "${SELLER_PANEL_ORIGIN}=${MARKET}"
set_env apps/admin/.env.local PANEL_HOSTS "${ADMIN_PANEL_ORIGIN}=${MARKET}"
set_env apps/web/.env.local STOREFRONT_HOSTS "${STOREFRONT_ORIGIN}=${MARKET}"
set_env apps/web/.env.local SELLER_SIGN_IN_URLS "${MARKET}=${SELLER_PANEL_ORIGIN}/sign-in"
set_env apps/web/.env.local STOREFRONT_IMAGE_ORIGIN "${API_ADDRESS}"

echo '[1/5] Installing packages'
pnpm install

echo '[2/5] Starting PostgreSQL, Redis and Mailpit'
docker compose up -d --wait

echo '[3/5] Preparing the database and the local Market configuration'
pnpm db:migrate
node scripts/dev-panels-market.mjs "$MARKET"
if [ "${1:-}" = seed ]; then node scripts/demo-seed/claim-vocabulary.mjs; fi
export MARKET_CONFIG_DIR="$PWD/.local/markets"
export SERVICE_AREA_CONFIG_DIR="$PWD/.local/service-areas"

# The Stripe values, for the processes only. A secret that is not a test-mode value is refused by
# the API and the buyer site at start-up.
stripe_env=()
[ -n "${SK_TEST:-}" ] && stripe_env+=("STRIPE_SECRET_KEY=${SK_TEST}")
[ -n "${WHSEC_TEST:-}" ] && stripe_env+=("STRIPE_WEBHOOK_SECRET=${WHSEC_TEST}")
[ -n "${WHSEC_CONNECT_TEST:-}" ] && stripe_env+=("STRIPE_CONNECT_WEBHOOK_SECRET=${WHSEC_CONNECT_TEST}")

echo '[4/5] Starting the API and the worker'
env "${stripe_env[@]}" nohup pnpm dev > "$LOGS/api.log" 2>&1 &
for attempt in $(seq 1 120); do
  if curl --silent --fail --max-time 3 http://localhost:3000/health > /dev/null; then break; fi
  if [ "$attempt" = 120 ]; then
    echo "The API did not answer within 10 minutes; see $LOGS/api.log" >&2
    exit 1
  fi
  sleep 5
done
env "${stripe_env[@]}" nohup pnpm dev:worker > "$LOGS/worker.log" 2>&1 &

echo '[5/5] Starting the seller and admin panels and the buyer site'
nohup pnpm dev:seller > "$LOGS/seller.log" 2>&1 &
nohup pnpm dev:admin > "$LOGS/admin.log" 2>&1 &
env STRIPE_TEST_PUBLISHABLE_KEY="${PK_TEST:-}" nohup pnpm dev:web > "$LOGS/web.log" 2>&1 &

if [ "${1:-}" = seed ]; then
  echo 'Filling the sample marketplace (log: .local/logs/seed.log)'
  nohup node scripts/demo-seed/index.mjs > "$LOGS/seed.log" 2>&1 &
fi

if gh codespace ports visibility 3000:public -c "$CODESPACE_NAME" > /dev/null 2>&1; then
  api_note='public, for Stripe webhooks'
else
  api_note='still private: in the Ports tab, right-click 3000, Port Visibility, Public'
fi

cat <<EOF

Started. Open (signed in to GitHub):
  Seller panel : ${SELLER_PANEL_ORIGIN}
  Admin panel  : ${ADMIN_PANEL_ORIGIN}
  Buyer site   : ${STOREFRONT_ORIGIN}
  API          : ${API_ADDRESS}  (${api_note})
  Stripe webhook address: ${API_ADDRESS}/payments/stripe/webhook/${MARKET}
  Logs         : ${LOGS}/
Sample logins (with seed): .local/demo-credentials.txt, when ${LOGS}/seed.log says Done.
Stripe test mode: secret key $([ -n "${SK_TEST:-}" ] && echo set || echo 'not set (SK_TEST)'), \
webhook secret $([ -n "${WHSEC_TEST:-}" ] && echo set || echo 'not set (WHSEC_TEST)').
EOF
