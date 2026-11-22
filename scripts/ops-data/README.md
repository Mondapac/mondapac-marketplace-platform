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
| `sellers` | 22 sellers: the storefront sample's 18 stores approved (About text, logo, minimum order, stock location), and one each in review, rejected, suspended and a draft file; the sample issuer and 4 halal certificates (submitted, checked, approved), and their culture membership | 2 |
| `products` | 107 platform products on level-3 categories (texts, attributes, pack-size or volume variants, the sample photos), 142 offers on the 18 stores (handling, first-publish approval, halal tags on certified sellers' meat and poultry), stock, regular prices, two-week special prices for the sample's "was" prices, and one price rise held for the admin | 2 |
| `orders` | Buyers, carts, orders paid with Stripe test confirmation tokens, the webhook | 3 |
| `content` | Through the storefront editor: 6 slides (3 on the home hero, 1 mid-page, 1 at the top of Meat and of Pantry, each with its picture), the home page (category circles, sellers near you, best sellers and special-price shelves, the information strip), the navigation (rail, popular departments, every department in the Browse drawer) the About, Delivery and Returns pages, and the blog (2 categories, 4 posts with cover pictures, product and store cards, one featured); notices are the announcement slides. The admin writes and submits, the reviewer approves and publishes | 4 |

Each pack creates only what is missing, so a rerun changes nothing. Catalogue changes are
reviewed in every Market (Admin Inbox › System requests): the admin makes them and the reviewer
approves them, so the environment shows the same maker-checker flow as production. The scenario of a Market is
`scenarios/<MARKET>/`; a second Market adds its own folder.

## Run it

```
docker compose up -d --wait
pnpm db:migrate
node scripts/ops-data/mark-database.mjs     # once per database: the operational test marker
LOCAL_MAIL_ORIGIN_LIMIT=200 node scripts/dev-panels-market.mjs AU   # local Market files in .local/
# start the API and the worker with MARKET_CONFIG_DIR=.local/markets,
# SERVICE_AREA_CONFIG_DIR=.local/service-areas and
# CATALOG_SEED_JOBS_OFF=catalog.seed-category-tree,catalog.seed-attributes,catalog.seed-cultures
node scripts/ops-data/index.mjs              # --market AU (default), --only sellers (and the packs before it)
```

`LOCAL_MAIL_ORIGIN_LIMIT` raises the sign-up mail limit per client address in the local Market
file only: every local client is 127.0.0.1, and the committed limit (10 an hour) would stop the
sellers pack after ten sign-ups. The limit per account stays as committed.

## The scenario

`scenarios/AU/` mirrors the buyer site's sample data (`apps/web/src/storefront/sample-*.ts`), so
the live site shows the stores, products, prices and "was" prices the sample showed, with more of
each. Store, business and product texts never use a claim word (halal, kosher, vegan, organic and
their terms): the catalog refuses them, and a claim is made only through a certificate. So the
sample's "Kedron Halal Butchers" is "Kedron Family Butchers" here and shows the Halal badge from
its approved certificate and its tagged offers. Onboarding needs an address inside the Greater
Brisbane service area, so Toowoomba Farm Direct sells from a stall at the Rocklea markets. The
category tree keeps the sample's departments and categories (levels 1 and 2) and adds the level-3
product categories products sit on. Every certificate, issuer and person is sample data, marked as
such where it is shown.

`CATALOG_SEED_JOBS_OFF` stops the worker from building the AU starter catalog from
`config/catalog-seed/` the moment it starts on an empty database; the loader builds the catalog
through the admin API instead. Roles, permissions and certification types still seed: they are
part of the software. The API refuses the setting unless `NODE_ENV` is explicitly `development`
or `test`. Switching the jobs back on for a database the loader already filled mixes the
starter tree into the admin-built one: reset the database instead. A switched-off job still runs
when started by hand (`runJobOnce`).

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
   cluster superuser (through the Compose `postgres` container, or `OPS_SUPERUSER_DATABASE_URL`
   when that is set and local). No migration, no table and no parameter grant to an application
   role (design platform.md 10.5), so a production database never has it, and the loader reads
   it from `pg_db_role_setting`, not from a session setting any client could change.
4. A Stripe key, when set, is a test-mode key (`sk_test_` or `rk_test_`); a live key is refused.

All sample addresses use the reserved `.example` domain and mail reaches only Mailpit.

## What is not done through the application yet

- **Slides with a link need the API fix of PR #1242**: before it, approving a slide whose link
  or scope names a category always answered `storefront.slide-link-invalid` on a real database.
- **Claim vocabulary**: catalog refuses every name while a Market has no published certification
  type, and certification types cannot be created in the admin yet, so the loader runs
  `scripts/demo-seed/claim-vocabulary.mjs` (SQL, the migration role) first. It goes when the
  certification type editor lands (future enhancements register).
