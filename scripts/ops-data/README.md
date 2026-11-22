# Operational test data

Builds a complete, realistic marketplace in the **local** operational test environment
(operational test data design, option A, phase 2), so the admin panel, the seller panel and the
buyer site can be tested like the real system. Every record is created through the running API,
the way the panels and the buyer site create it: the domain rules, events, mails, audit rows and
the Admin Inbox requests all happen as they would in a real sale. No raw seeds.

It replaces `scripts/demo-seed` pack by pack; the demo seed already uses this folder's `guard.mjs`
and `lib.mjs`.

## Packs

| Pack | What it builds | PR |
|---|---|---|
| `admin` | The platform admin (`identity-admin first-admin`) and a second admin, the reviewer (`identity-admin second-admin`); each invitation read from Mailpit, accepted with TOTP | 1 |
| `catalog` | Categories (created, then shown), attributes (created, then published), feature sets, each department's feature set and buyer filters, cultures, through the admin API; the reviewer approves what waits for a second admin and the reviewed-after changes | 1 |
| `sellers` | Sellers in every state, products, offers, prices, stock | 2 |
| `orders` | Buyers, carts, orders paid with Stripe test confirmation tokens, the webhook | 3 |
| `content` | Home page, slides, menu, blog, notices | 4 |

Each pack creates only what is missing, so a rerun changes nothing. Catalogue changes are
reviewed in every Market (Admin Inbox › System requests): the admin makes them and the reviewer
approves them, so the environment shows the same maker-checker flow as production. The scenario of a Market is
`scenarios/<MARKET>/`; a second Market adds its own folder.

## Run it

```
docker compose up -d --wait
pnpm db:migrate
node scripts/ops-data/mark-database.mjs     # once per database: the operational test marker
node scripts/dev-panels-market.mjs AU        # local Market and service-area files in .local/
# start the API and the worker with MARKET_CONFIG_DIR=.local/markets,
# SERVICE_AREA_CONFIG_DIR=.local/service-areas and
# CATALOG_SEED_JOBS_OFF=catalog.seed-category-tree,catalog.seed-attributes,catalog.seed-cultures
node scripts/ops-data/index.mjs              # --market AU (default), --only admin,catalog
```

`CATALOG_SEED_JOBS_OFF` stops the worker from building the AU starter catalog from
`config/catalog-seed/` the moment it starts on an empty database; the loader builds the catalog
through the admin API instead. Roles, permissions and certification types still seed: they are
part of the software. The API refuses the setting unless `NODE_ENV` is explicitly `development`
or `test`.

The loader's state (the data version, finished packs, the admin's authenticator secret) is in
`.local/ops-data/<MARKET>.json`. `DATA_VERSION` in `index.mjs` is the scenario's version: a
database built with another one is not topped up; rebuild it.

## Guards: never on production

The loader runs only when all of these hold; there is no flag that switches any of them off
(`guard.mjs`):

1. `NODE_ENV` is unset, `development` or `test` (the demo seed's strict rule, unchanged).
2. The API, the mail catcher and the database URLs all point at this machine (`localhost`,
   `127.0.0.1`, `::1`, `*.localhost`), with no host smuggled in through a query parameter.
3. The database carries the operational test marker in its own database-level settings:
   `ALTER DATABASE <db> SET mondapac.env = 'ops-test'`, written by `mark-database.mjs` as the
   migration role (the database owner). No migration and no table, so a production database
   never has it, and the loader reads it from `pg_db_role_setting`, not from a session setting
   any client could change. `scripts/db/bootstrap-dev.sql` grants the migration role the right to
   set this one parameter (development and CI clusters only); on an older Compose volume run
   `pnpm db:bootstrap` once.
4. A Stripe key, when set, is a test-mode key (`sk_test_` or `rk_test_`); a live key is refused.

All sample addresses use the reserved `.example` domain and mail reaches only Mailpit.

## What is not done through the application yet

- **Claim vocabulary**: catalog refuses every name while a Market has no published certification
  type, and certification types cannot be created in the admin yet, so the loader runs
  `scripts/demo-seed/claim-vocabulary.mjs` (SQL, the migration role) first. It goes when the
  certification type editor lands (future enhancements register).
