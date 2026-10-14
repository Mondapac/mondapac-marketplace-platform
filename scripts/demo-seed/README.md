# Demo seed

Fills a **local** development database with a small Brisbane marketplace so the panels (and later
the buyer site) have something to show: one platform admin, five sellers (four approved, one
waiting for review), 14 platform products with categories, attributes and variants, 19 live
offers, stock, prices, one active special price, one held price waiting for the admin, and one
buyer. It drives the running API the way the panels do, so every record passes the domain rules.

## One command (Windows)

`scripts\demo-local.bat` (same as `scripts\dev-local.bat seed`): starts Docker services, applies
migrations, starts the API, worker and both panels, then runs the seed in its own window.
Sample logins land in `.local/demo-credentials.txt`.

## By hand

```
docker compose up -d --wait
pnpm db:migrate
node scripts/dev-panels-market.mjs AU      # local Market and service-area files in .local/
node scripts/demo-seed/claim-vocabulary.mjs # before the worker starts (see below)
# start the API and the worker with MARKET_CONFIG_DIR=.local/markets and
# SERVICE_AREA_CONFIG_DIR=.local/service-areas, then:
node scripts/demo-seed/index.mjs
node scripts/demo-seed/admin-code.mjs       # the admin's current 6-digit sign-in code
```

The seed is idempotent: a second run changes nothing. To start over, wipe the database
(`docker compose down -v`) and delete `.local/demo-state.json`.

## What is not done through the application yet

- **Claim vocabulary** (`claim-vocabulary.mjs`): catalog refuses every product text and category
  name while a Market has no published certification type, and certification has no way to create
  one yet. The script writes halal, kosher, vegan and organic with their terms by SQL (the
  migration role). It goes away when the certification package lands.
- The AU starter categories and attributes are `config/catalog-seed/AU.json` (loaded by the
  catalog seed jobs at worker start), until slice 21.

## Production guard

`guard.mjs` refuses to run unless `NODE_ENV` is unset, `development` or `test` and the API, mail
catcher and database URLs all point at this machine (`localhost`, `127.0.0.1`, `::1`,
`*.localhost`). There is no flag to switch it off. The mail catcher the seed reads sign-in links
from is itself refused by the API outside development and test.
