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
| `orders` | 30 buyers (Alex Nguyen and the buyer site's account sample first) with their address books; 33 orders paid by card on the MondaPac page (`POST /orders/pay`) with Stripe test ConfirmationTokens, Stripe's test events delivered to the local webhook, each order taken as far as its scenario says by the store and the admin: paid and waiting, ready (pickup code live), collected, refunded (one line, damaged), cancelled; two declined cards and two 3D Secure payments left waiting; 6 open carts | 3 |
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
STOREFRONT_ORIGIN=http://storefront.localhost:3003 LOCAL_MAIL_ORIGIN_LIMIT=200 node scripts/dev-panels-market.mjs AU   # local Market files in .local/
# start the API and the worker with MARKET_CONFIG_DIR=.local/markets,
# SERVICE_AREA_CONFIG_DIR=.local/service-areas and
# CATALOG_SEED_JOBS_OFF=catalog.seed-category-tree,catalog.seed-attributes,catalog.seed-cultures
node scripts/ops-data/index.mjs              # --market AU (default), --only sellers (and the packs before it)
```

`LOCAL_MAIL_ORIGIN_LIMIT` raises the sign-up mail limit per client address in the local Market
file only: every local client is 127.0.0.1, and the committed limit (10 an hour) would stop the
sellers pack after ten sign-ups. The limit per account stays as committed.

### The orders pack and Stripe

The `orders` pack pays with Stripe in **test mode** and needs, in `.env` (read by the API and the
loader alike):

- `STRIPE_SECRET_KEY`: a test-mode key (`sk_test_` or `rk_test_`; a live key is refused);
- `STRIPE_PAYMENT_METHOD_CONFIGURATION`: the cards-only payment method configuration (`pmc_`);
- `STRIPE_WEBHOOK_SECRET`: any `whsec_` value of your own (for example `whsec_` and 48 random hex
  characters). Stripe cannot reach a local API, so the loader reads the real test events of each
  payment it made (`GET /v1/events`) and posts them to `POST /payments/stripe/webhook/<MARKET>`,
  signed with this secret as Stripe signs. The API reads the payment again from Stripe before it
  confirms anything, so a replayed event is only a nudge.

Write the local Market file with these set, then start the API after it:

```
STOREFRONT_ORIGIN=http://storefront.localhost:3003 LOCAL_MAIL_ORIGIN_LIMIT=200 \
  LOCAL_SIGN_IN_ORIGIN_LIMIT=300 LOCAL_REFUND_CREDIT=1 node scripts/dev-panels-market.mjs AU
```

- `STOREFRONT_ORIGIN`: the API allows the buyer site's origin, so the buyers can sign up;
- `LOCAL_SIGN_IN_ORIGIN_LIMIT`: like the mail limit, the per-address sign-in limit (30 in 15
  minutes) would stop the pack, which signs in the admins, the stores and thirty buyers from
  127.0.0.1; the per-account limits stay as committed;
- `LOCAL_REFUND_CREDIT=1`: refunds and cancellations are off in the committed Market file
  (`tax.refundCredit.enabled`, until the registered tax agent confirms); this switches them on in
  the local file only. Without it the orders to cancel or refund stay paid or collected, and a
  later run with it finishes them.

 The cards are
Stripe's test payment methods (`pm_card_visa`, `pm_card_mastercard`, `pm_card_chargeDeclined`,
`pm_card_authenticationRequired`): no card number is written anywhere. Every pickup is collected in
person, because the local environment has no courier (future enhancements register). Where
`api.stripe.com` cannot be reached (some networks block it), run the loader in a cloud
environment that allows it; behind an HTTPS proxy, start the API, the worker and the loader with
`NODE_USE_ENV_PROXY=1` (Node's own `fetch` ignores `HTTPS_PROXY` otherwise).

## Reset, fast restore and the .bat (phase 3)

On Windows, `scripts\ops-local.bat` does it all (`scripts\demo-local.bat`, the older and smaller demo, stays as it is):

| Command | What it does | Time |
|---|---|---|
| `scripts\ops-local.bat` | Starts Docker services, the API, the worker, the panels and the buyer site (as `dev-local.bat`), marks the database, runs the loader (a rerun changes nothing). The first run also saves the backup. | first run: minutes |
| `scripts\ops-local.bat reset` | Closes the running windows, drops and creates the database, hands it to the migration role (`bootstrap-dev.sql`), empties Redis, runs the migrations and the loader, then saves the backup. | minutes |
| `scripts\ops-local.bat fast` | Closes the windows and restores the backup, then starts. Refused when the code's migrations are not the backup's (then run `reset`). | seconds |

`scripts\ops-local.bat refresh [--orders N]` (`node scripts/ops-data/refresh.mjs`) adds fresh activity to the
running environment and deletes nothing, so the dashboards and lists show today's data: shelves below half
of the scenario's level are filled again, a "was" price whose special price ended or ends within 3 days gets a
new two-week window, and a batch of today's orders (default 6, at most 20; keys `r<YYYYMMDD>-<n>`) is paid in
Stripe test mode and taken to paid, ready, collected, and one cancelled by the admin (local only, like every
refund). A rerun on the same day tops the batch up and never pays twice; the next day adds a new batch. It
needs the API, the worker and Mailpit running and a finished loader run (the same data version), takes the
loader's run lock (so it cannot overlap a reset, a fast restore or a loader run), and runs every guard first.
Without a Stripe test key the shelves and prices are refreshed and the orders are left out. After `fast`, run
`refresh` to bring the restored data up to the day.

The two share one database. When it holds other data (the demo's) and has no operational test marker,
`start` stops and `reset` asks you to type YES before replacing it. Without a test-mode Stripe key in
`.env`, the orders pack is left out.

`scripts/ops-data/ops.mjs` has the steps (`wipe`, `backup`, `restore`, `check`, `unlock`); every one runs
the guards first. The backup is `.local/ops-data/backup/` (a `pg_dump -Fc` made inside the Compose
container, without owners but with the table grants, the migration list, and the loader's state, which
holds the admin's authenticator secret). A lock (`.local/ops-data/lock.json`) keeps a reset, a fast
restore and a loader run from overlapping; a crashed run's lock is ignored (the process is gone), a reset's
goes stale after 90 minutes, and `node scripts/ops-data/ops.mjs unlock` clears either.

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
`.local/ops-data/<MARKET>.json`. `DATA_VERSION` in `state.mjs` is the scenario's version: a
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
The orders pack calls Stripe only with that test key, refuses any Stripe answer that is not
test mode, replays only the events of a PaymentIntent it made itself (platform events, not a
connected account's) and posts them only to the local API (guard 2). It never prints the key or
the webhook secret, and uses Stripe's test payment methods (`pm_card_*`), never a card number.

## What is not done through the application yet

- **Claim vocabulary**: catalog refuses every name while a Market has no published certification
  type, and certification types cannot be created in the admin yet, so the loader runs
  `scripts/demo-seed/claim-vocabulary.mjs` (SQL, the migration role) first. It goes when the
  certification type editor lands (future enhancements register).
