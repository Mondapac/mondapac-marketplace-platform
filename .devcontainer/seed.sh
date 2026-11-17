#!/usr/bin/env bash
# Fills the codespace database with the sample Brisbane marketplace (scripts/demo-seed): one
# platform admin, five sellers, 14 products, offers, stock, prices and a buyer. The same as
# `scripts\dev-local.bat seed`. Logins: .local/demo-credentials.txt. Safe to run again.
set -euo pipefail
umask 022
cd "$(dirname "$0")/.."

# The catalog refuses every text until the Market has a claim vocabulary; the worker must start
# after it exists (scripts/demo-seed/README.md), so stop the apps, write it, then start them again.
bash .devcontainer/stop.sh
node scripts/demo-seed/claim-vocabulary.mjs
bash .devcontainer/start.sh
node scripts/demo-seed/index.mjs
echo "Sample logins: .local/demo-credentials.txt (admin sign-in code: node scripts/demo-seed/admin-code.mjs)"
