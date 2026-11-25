# reporting: facts and daily rollups of the dashboards (dashboards upgrade, option B, phase 3)

Speed mode (CLAUDE.md): no G1/G2. The owner chose option B of the dashboards upgrade on
22 Nov 2026. The spec is sections 2 to 4 and 6 of the design
(`design/admin/dashboards-upgrade/dashboards-upgrade-fa.html` in the project files); the phase plan
is `handoffs/dashboards-upgrade/phase-plan.md` there.

## Rules

- `reporting` never reads another module's table. Facts arrive from the owners' facades: the event
  worker (PR 10), the nightly 7-day reconcile (PR 10) and the history backfill (PR 12).
- Every fact and rollup carries `market_id` and `tenant_id`. `market_day` is the day of the instant
  in the Market's configured zone (Market configuration), never UTC.
- Money is BigInt minor units with its currency. Every amount includes tax and has its tax beside
  it, so the amount without tax is `amount - tax` (GMV with and without GST).
- GMV counts goods only, after discounts, of paid seller orders, on the paid day. Shipping is kept
  apart.
- A refund counts on its own day: its goods are negative sales entries on that day, and the day of
  the order it refunds never changes, so a past day's number stays as it was.
- A fact is the owner's state as read, not a delta: recording it again writes the same rows, and
  calls in any order converge.

## Tables (`20261122200000_reporting_daily_rollups`)

- `seller_orders`: one per seller order; the four instants (paid, cancelled, shipped, delivered)
  with their Market days, goods and shipping totals, `shipped_on_time`.
- `refunds`: one per succeeded refund, positive totals (goods and shipping, with tax).
- `sales_entries`: goods per category of a sale (positive) or of a refund (negative). The nil UUID
  is the category of goods whose category could not be read.
- `daily_seller_sales`: one row per Market day, seller and currency. Refunds there are NEGATIVE,
  like the refund sales entries and `daily_category_sales`, with goods and shipping apart: net GMV
  of a range is `sum(goods_amount + refund_goods_amount)`, without tax
  `sum(goods_amount - goods_tax_amount + refund_goods_amount - refund_goods_tax_amount)`.
- `daily_category_sales`: one row per Market day, seller, category and currency.
- `inbox`: the worker's idempotency (P 6.4).

The application role may rewrite a fact's measures but never its keys, seller, order or currency;
sales entries and rollup rows are replaced as a whole (delete and insert), so the rollups have no
UPDATE grant. A fact that names another order, seller or currency than the stored one, or a refund
whose seller or currency differs from its seller order's, throws `ReportingFactConflict` (Hassan).
Every fact is in the Market's default currency, and its goods by category add up to its goods.

Concurrency (Mojtaba): callers run `FactRecorder` in a SERIALIZABLE unit; two events of one seller
day then conflict with a 40001 the platform retries, instead of one missing the other's fact.
Seller days are rebuilt in a fixed order (day, then seller). Growth and retention:
`docs/design/data/reporting.md`.

Not everything here is rebuildable any more (Mojtaba M1, dashboards v2 phase 2):
`seller_monthly_goals` holds the sellers' own goals, authored data no backfill can bring back. Any
future reset or rebuild runbook of reporting must leave that table out, and it stays in backup and
point-in-time recovery scope like every module's own data.

Early warning (Mojtaba, 24 Nov 2026): units of DIFFERENT sellers and days can also meet. When the
reporting db-specs shared one database and ran in parallel, their SERIALIZABLE units failed with
40001 at random (3 of 3 local runs of the five reporting files): on near-empty tables the predicate
(SIREAD) locks are relation-level (a sequential scan) or cover the single index page that holds
every key, so unrelated seller days read as rw-conflicts. Each of those spec files now has its own
database copy (`test/db/global-setup.ts`); the isolation level is unchanged. In production the
tables are indexed on the deleted prefixes (primary keys from `market_id, market_day, seller_id` and
`market_id, kind, source_id`), so index scans take tuple or leaf-page locks and such false conflicts
between concurrent projector units (event worker, nightly reconcile, backfill) MAY still happen
under load, much more rarely; the platform's retry absorbs them. Measure the 40001 and retry rate of
reporting units first, then in this order: confirm with `EXPLAIN` that the unit's queries use index
scans; check the granularity of `pg_locks` rows with `mode = 'SIReadLock'`; only then consider
`max_pred_locks_per_relation` / `max_pred_locks_per_page` tuning or partitioning the events by seller
day (FE-20261124-reporting-serializable-predicate-locks).

## Code

- `application/fact-recorder.ts` (`FactRecorder`): the one write path. It writes the facts, then
  rebuilds every seller day the facts touched before and after the write (`domain/rollup.ts`), in
  the caller's unit.
- `domain/facts.ts`: Market day, `withTax` (a price with or without tax, as an amount with tax),
  the sale and refund entries.

## What reporting reads of the owners (PR 10)

All rule `system`, not exposed over HTTP; ids and money only (no name, address, email or customer).

- `ORDERING_REPORTING_FACADE` (`ordering/contracts/ordering-reporting.facade.ts`):
  `sellerOrderReportFacts` (at most 100 seller orders: goods per line after discount with tax,
  shipping after discount with tax, paid, cancelled, shipped and delivered times, on time),
  `refundReportFacts` (succeeded refunds only, with the Offer of each refunded line),
  `sellerOrdersChanged` and `refundsSucceeded` (ids whose instants fall in a window, keyset-paged by
  id, at most 500; a window with no start is the whole history, for the backfill).
- On time (for now): the seller handed the order over (ready, else shipped) by its ready-by promise
  (`readyByOf`). Null with no promise, or unshipped within it; false once it passed unshipped. To be
  replaced by the per-delivery-method promise of phase 1 (repo register FE-060, project register FE-093).
- `CatalogFacade.offerPrimaryCategories` (at most 200 Offers): the primary platform category of the
  product's published revision; a deleted Offer still answers. The category is read when the fact is
  written, so a later move of the product changes past days only at the next reconcile or backfill
  (repo register FE-059, project register FE-092).
- No customer id is copied into reporting (repo register FE-061, project register FE-094).
- The fact reads load the whole request at once: one read of the orders (seller orders and lines
  included) per seller-order call, one of the refunds and one of their orders per refund call
  (Mojtaba, PR 10 finding 2).
- The changes scans walk `seller_orders` and `refunds` by `(market_id, id)` and filter each row: no
  index answers an OR of five instants, one of them on the order. Correct for the backfill and cheap
  at launch volume. Trigger: when `ordering.seller_orders` passes about 200k rows of a Market, or a
  nightly run takes more than 2 s, run one keyset query per instant (cancellations by the ids of the
  orders cancelled in the window), merge them in memory, and add the partial indexes
  `seller_orders (market_id, ready_at, id) WHERE ready_at IS NOT NULL`, the same for `shipped_at` and
  `delivered_at`, `orders (market_id, cancelled_at, id) WHERE cancelled_at IS NOT NULL` and
  `refunds (market_id, settled_at, id) WHERE state = 'succeeded'` (Mojtaba, PR 10 findings 1 and 3;
  repo register FE-062, project register FE-105).

## Event worker and nightly reconcile (PR 10b)

- Subscriptions (`presentation/subscribers/report-facts.subscriptions.ts`, `reporting.inbox`):
  `ordering.order-paid.v1` and `ordering.order-cancelled.v1` (every seller order of the order),
  `ordering.order-shipped.v1` and `ordering.seller-order-delivered.v1` (that seller order),
  `ordering.refund-succeeded.v1` (that refund). Each hands the ids to `reporting.record-report-facts`
  (rule `system`), which reads the facts again from ordering's reporting facade and catalog's
  `offerPrimaryCategories` before any unit, then records them in one `runOnce` unit with
  `isolation: 'serializable'` (Mojtaba F1 of PR 9).
- A seller order that was never paid is not recorded: it counts in no rollup.
- An Offer catalog cannot place goes to `UNKNOWN_CATEGORY`; the part of a refund its lines do not
  cover goes there too, with 0 units, so goods by category always add up to the fact's goods.
- `reporting.reconcile-facts` (job, daily): reads every seller order and refund with an instant in
  the last seven days (`sellerOrdersChanged`, `refundsSucceeded`, pages of 100) and records them in
  serializable units of at most 25 facts (timeout 15 s), each seller day rebuilt once per unit and
  facts written in id order. A unit that keeps conflicting is tried again after a pause; a batch
  that fails otherwise is retried one fact at a time, the facts still refused are logged by id
  (`reporting.fact-write-failed`) and skipped, and the run then fails so the scheduler reports
  it. A cursor that does not move on, or more than 10,000 pages, stops the run. It also catches what no event names:
  an on-time promise that passed, a product moved to another category.
- A seller order's instants only go from unknown to known, so an older read written after a newer
  one keeps what is stored (`keepKnownInstants`; Hassan, PR 10b finding 1): an event's facade read
  happens before its unit, so two deliveries of one seller order can write in the other order.
- Migration `20261122200100_reporting_refunds_seller_order_index` adds
  `refunds (market_id, seller_order_id)` for the check below (Mojtaba, PR 10b finding 1).
- `putSellerOrder` also refuses a seller order whose refund, recorded before it, names another
  seller, order or currency (Hassan, PR 9 re-review).
- Rule to revisit: if ordering ever clears an instant (a shipment undone, for example), reporting
  keeps the stored one until `keepKnownInstants` learns that case. Amounts are not merged: ordering
  does not change goods or shipping after payment (Hassan, PR 10b re-review).

## History backfill (PR 12)

- `reporting.backfill-history` (job, every 5 minutes and at worker start; use case of the same name,
  rule `system`): reads every seller order and refund with an instant before the moment the backfill
  first started (the window `[history, until)`), in id order, pages of 100, through the same page
  writer as the nightly reconcile (`writePage`: units of 25, conflict pauses, facts that still fail
  logged by id as `reporting.fact-write-failed` with the job and kind). Facts after `until` come
  from the event worker and the nightly reconcile.
- Progress: `reporting.backfill_progress` (migration `20261122220000_reporting_backfill_progress`),
  one row per Market and kind (`seller-orders`, then `refunds`), both created in one unit at the
  first start so they share `until`. Each row holds the id cursor `after` of the last page saved,
  `pages`, `failed_facts` and `finished_at`. The cursor is saved in its own unit after each page,
  so a run that fails, stops or times out goes on from the last page saved. The application role
  may update only the cursor columns.
- Each run writes at most 20 pages (2,000 facts) and starts no page after 60 s on the injected
  clock, one page after the other (`maxRunMs` 180 s, so the worker's long-job lane stays free for
  imports and reindexes; Mojtaba, PR 12 finding 1). Once both kinds are finished, a tick only reads
  the progress rows.
- Idempotent: every fact write replaces, and `advance` moves the cursor only from where the run read
  it (and only while unfinished), so a late run that overlaps another writes one page again at most
  and then stops (at READ COMMITTED the second UPDATE waits on the row and re-checks its WHERE).
- A failed read, or a fact that failed for a reason that may pass (a conflict after every round, a
  timeout, a lost connection), stops the run before the cursor moves, so the next run writes that
  page again (Hassan, PR 12 M1). A fact the recorder refuses (another currency, goods that do not
  add up, a changed identity), or that the database refuses (SQLSTATE class 22 or 23, Prisma
  P2000, P2003, P2004, P2011; Mojtaba, PR 12 re-review), is counted in `failed_facts` and passed
  over, and the run fails so the scheduler reports it. A fact that keeps failing in a way that may
  pass (logged with `refused: false`, every run) holds the backfill at its page: look it up by id
  in `reporting.fact-write-failed`.
- Recovery for a refused fact older than the reconcile's seven days, or to run the backfill again
  after a recorder fix: an operator deletes the Market's sales rows of
  `reporting.backfill_progress` (`seller-orders`, `refunds`, `delivery` and `buyer-first`; the
  `ledger` row has its own reset, below) as the migration role (all four, so the kinds keep one
  window end); the next tick starts again with a new `until`. There is no admin screen for
  this yet (FE register, «پیشرفت backfill گزارش در پنل ادمین»).
- The nightly reconcile's counter is now `failedFacts` (it always counted facts, not batches).
- Follow-up (Hassan, PR 12 L3): `isFactRefusal` treats any `RangeError` or `TypeError` as a
  refusal; a reporting-owned refusal error class would keep a future programming error from being
  passed over (FE register, «خطای ردّ ویژهٔ reporting»).


## Delivery method and state (dashboards v2, phase 1, PR 3)

- `seller_orders.delivery_method` (pickup, instant, same_day, scheduled; CHECK) and
  `seller_orders.delivery_state` (`VARCHAR(3)`, 1 to 3 capital letters or digits; CHECK, and only with
  a method), migration `20261124010000_reporting_seller_orders_delivery`. Attributes of the fact,
  not rollup keys: no rollup or index changes. The application role may UPDATE both (they are
  measures of the fact, not its keys).
- Unknown is NULL, the same as `shipped_on_time` (no sentinel such as `UNK`): a delivery placed
  before quotes were kept (delivery models, package 5), a quote shipping no longer holds, a seller
  without an approved pickup postcode, or a postcode in no configured range. A NULL method only
  marks a row recorded before the columns.
- Sources: ordering's reporting facade now gives `deliveryMethod` and `deliveryQuoteId` (shipping's
  quote id, a plain id). Shipping's new `SHIPPING_REPORTING_FACADE.deliveryRegions` (use case
  `shipping.delivery-regions`, rule `system`, at most 100 quotes and 100 sellers) reads the quote's
  `dropoff_postcode`, or for a pickup the seller's approved pickup postcode (sellers'
  `pickupPostcodes`, now also answering the system actor as `sellers.pickup-postcodes-system`), and
  maps it with the Market's `shipping.postcodeRegions`. Only the region code leaves shipping:
  reporting never receives, logs or stores a postcode, an address or ship-to ciphertext.
- `shipping.postcodeRegions` is Market configuration (`platform/market-config/postcode-regions.ts`):
  closed ranges per region code; a postcode matches a range of its own length; ranges of one length
  must not overlap; every code must be in `customers.address.regions`. AU has the main Australia Post
  ranges (border postcodes go to the range's state, repo register FE-20261123-au-postcode-state-table); the synthetic Market has
  its own. No country is named in code.
- Once known, a state is kept as first recorded (`keepKnownInstants`): a later read may no longer
  know it (shipping removes a buyer's expired quotes 24 hours later) or may give the store's new
  region after a move. The method is ordering's and never changes. A state that stays unknown
  because the quote was removed before the first record: repo register FE-20261123-delivery-region-at-checkout.
- All three writers fill the columns (the event worker, the nightly reconcile, the history backfill),
  since they share `ReportSources.sellerOrders`. A shipping failure fails the read like a catalog
  failure: the delivery or the page is tried again.
- Rows recorded before the columns: the backfill's third kind `delivery` (after `seller-orders` and
  `refunds`; the kind CHECK of `backfill_progress` allows it). It walks reporting's own
  `seller_orders` of the Market with `delivery_method IS NULL` by `(market_id, seller_order_id)`
  (primary key), pages of 100, records each page again through the same writer, and saves its
  cursor after each page, so it resumes after a stop. Every fact it writes gets a method, so the pass
  ends even when the state stays unknown. On a Market whose backfill finished before this PR, the
  first tick adds the `delivery` row (with its own `until`, which the pass does not use). The reset
  procedure above deletes it with the other sales rows. The CHECK swap keeps every kind before it
  (`seller-orders`, `refunds`, `ledger`) and adds `delivery`.

## Buyer-first flags (dashboards v2, phase 2: new and returning customers)

- `seller_orders.buyer_first_order` and `seller_orders.buyer_first_with_seller` (booleans, NULL =
  unknown), migration `20261124020100_reporting_seller_orders_buyer_first`; CHECK
  `seller_orders_buyer_first_check` (both or neither, only with `paid_at`, a first order is the
  first with its seller). Attributes of the fact, not rollup keys: no rollup or index changes. The
  application role may UPDATE both.
- Source: ordering decides them once, in the unit that confirms the payment, from its own claim
  tables (`docs/design/data/ordering.md` 3.16), and its reporting facade gives `buyerFirstOrder` and
  `buyerFirstWithSeller`. Reporting never receives, stores or logs a customer or account id (a test
  checks that no reporting column names one); the dashboards count new and returning customers from
  the flags alone (a customer is new in a period if their first paid order is in it).
- Once known, the flags are kept as first recorded (`keepKnownInstants`): a later read never
  rewrites a past order's new-or-returning customer. The recorder refuses contradictory flags
  (`checkedBuyerFirst`), as the CHECK does.
- Unknown (NULL): unpaid; paid before ordering recorded the flags and not seen by ordering's
  migration backfill (an order paid by the previous release during the deploy) and not yet filled
  by ordering's release step (`scripts/db/ordering-buyer-first-backfill.sql`, run once after the
  deploy; ordering data 3.16); or recorded here before the columns. Reporting does not re-read a
  row its `buyer-first` pass already walked: if the ops script filled flags after that pass
  finished, delete the Market's `reporting.backfill_progress` row of kind `buyer-first` (migration
  role) and the next tick walks the still-unknown rows again (known flags are kept). Until then such
  a row counts as neither new nor returning.
- Rows recorded before the columns: the backfill's fourth sales kind `buyer-first` (after
  `seller-orders`, `refunds` and `delivery`; the kind CHECK of `backfill_progress` allows it). It
  walks reporting's own paid `seller_orders` of the Market with `buyer_first_order IS NULL` by
  `(market_id, seller_order_id)`, pages of 100, records each page again through the same writer and
  saves its cursor after each page; a row ordering cannot tell stays NULL and the pass moves on, so
  it ends. On a Market whose backfill finished before this PR the first tick adds its row. The
  reset procedure above deletes it with the other sales rows.

## Admin KPIs (phase 5, PR 14)

`GET dashboard/admin/kpis?period=today|7d|30d|month` (default `7d`; any other value or key is
`validation.failed`). The dashboard composes two reporting reads and leaves out a section the
viewer has no key for; one that fails or takes over 1.5 s answers `status: error` and the other
still answers.

- `reporting.view-marketplace-operations-kpis` (key `ordering.order.view`): paid orders, cancelled
  and the cancel rate, shipped and the on-time rate, refund count. No money.
- `reporting.view-marketplace-finance-kpis` (key `commission-payouts.settlement.view`, the ledger's
  finance key; a dedicated key is FE-068; every role granted the ledger now also sees marketplace GMV, and the two cannot be granted apart: Hassan's note, 22 Nov): GMV with and without GST (goods only, shipping apart),
  refunded goods on their refund day (positive, never lowers GMV), refund rate, net sales (GMV minus
  that range's refunds) and the average order. Net revenue and take rate wait for a week of matching
  ledger (FE-066).
- Both: a platform admin acting as themselves only (`access.denied` for a seller, an acting-as
  session or a customer). Each answers the period, the previous period of the same length (for
  `month`, the same number of days from the first of the previous month), one point per day of both
  for the dashed line, a change per number and when the newest rollup row was rebuilt ("updated N
  min ago").
- "Today" and every day are the Market's days (zone from Market configuration), never UTC.
- Money is minor units as strings with the Market's currency (the only currency read, FE-069).
- Rates are basis points. A change is a percentage in basis points of the previous value, or `na`
  when the previous value is zero or below 5 orders, 5 refunds or 100.00 of money. A rate's change
  is the difference in basis points (2.0% to 3.5% is +150), or `na` when a period has no rate or the previous period is below the same minimum bases.
- Cancel rate is cancelled on their cancel day ÷ paid on their paid day, so in a short period such as today it can pass 100%; a cohort rate is not built (Sajad's note, 22 Nov).
- Both sections read "now" separately, so a request across Market midnight could show two different periods (`period.id`/dates are in each section).
- On time counts only shipped orders; an order unshipped past its promise is not in the rollup yet,
  so the figure can read better than the truth (FE-067).
- One grouped read per range of `daily_seller_sales`, summed over sellers in the database, in one
  read-only unit (ADR-0025). No cache (FE-070 when it is needed).
- No table, migration or permission is added.
- Order flow card (phase 5, part 2): the operations answer also carries `ordersDelivered`
  (`daily_seller_sales.orders_delivered`). The admin card shows paid, shipped and delivered as a
  funnel of the period's own counts, plus cancelled (with the cancel rate) and refund counts. It is
  not a cohort: an order paid before the period and shipped in it counts as shipped, so the
  percentages are approximate (FE-147). It needs only `ordering.order.view`.
- Top sellers card (phase 5, part 2, PR 2): `reporting.view-marketplace-top-sellers` (key
  `commission-payouts.settlement.view`, platform admin only) reads the five sellers with the most
  GMV in the period from `daily_seller_sales` (one grouped read, ties by seller id) with orders,
  on-time rate and refund rate (refunded goods ÷ GMV of the range). The dashboard joins the public
  store name from `sellers.sellerSummaries`; a name that cannot be read shows "Unnamed store" and the
  money still shows. Store links need `sellers.seller.view`.
- Top categories card (PR 3): `reporting.view-marketplace-top-categories` (same key) reads the five
  categories with the most goods sold from `daily_category_sales` (every seller summed), gross of
  refunds (the card says so). The dashboard joins names from `catalog` `categoryTree`; the nil UUID
  (goods whose category could not be read) and a deleted category show as "Uncategorised".
- Marketplace health card (PR 4): the operations answer carries `sellersWithOrders` (sellers with a
  paid order in the period, from `daily_seller_sales`). The dashboard adds a `health` section from
  two owners' work-queue counts with the caller's context: listings with a lapsed certificate
  (`catalog.claimsWithoutCertificate`, key `catalog.product.view`, shown as an incident when above
  zero) and sellers in the health queue (`sellers.unhealthySellers`, key `sellers.seller.view`).
  Each count is under the 1.5 s limit and answers `error`, never zero, when it fails. The percentage
  of verified halal listings, sellers with orders out of approved sellers, out of stock everywhere
  and products missing details need new owner counts (FE-148, FE-149). The KPI strip loads only for
  a session with the orders or the money key, so the card needs one of them too (FE-150).

## Ledger facts, net revenue and net earnings (dashboards v2, phase 1, PR 4)

- What reporting reads: `COMMISSION_PAYOUTS_REPORTING_FACADE`
  (`commission-payouts/contracts/commission-payouts-reporting.facade.ts`), rule `system`, not over
  HTTP, read only: `ledgerReportEntries` (the rows of at most 100 seller orders) and
  `ledgerEntriesRecorded` (rows recorded in a window, keyset by entry id, at most 500). Only the
  kinds `commission`, `refund-commission`, `cashback-seller` and `refund-cashback-seller`, and only
  ids and money: entry, seller order, seller, kind, amount, commission base, currency, occurred at.
  No order, line, rate, source (refund, credit), customer or name.
- Worker: `commission-payouts.ledger-recorded.v1` (subscriber `reporting.ledger-recorded`, inbox)
  hands the posting's seller order to `reporting.record-ledger-facts`, which reads every reportable
  row of that seller order again (not only the posting), then records them in one `runOnce` unit,
  serializable. A redelivery is stopped by the inbox; a late or repeated event of the same seller
  order writes nothing new.
- Facts: `reporting.ledger_entries` (migration `20261123120000_reporting_ledger_facts`), one row
  per ledger row, insert-only (no UPDATE grant), amounts as stored (never negative, the kind gives
  the direction), `market_day` of `occurred_at` in the Market's zone. A row read again that differs
  from the stored one throws `ReportingLedgerConflict` (never overwritten); a row in another
  currency, or malformed, is a `RangeError`. Rollup: `reporting.daily_ledger`, one row per Market
  day, seller, currency and kind (entries, distinct seller orders, amount, base), rebuilt per seller
  day by delete and insert (no UPDATE grant), like the sales rollups.
- Backfill: `reporting.backfill-ledger` (job, every 5 minutes and at worker start) reads every
  reportable row recorded before its own first start, pages of 200, at most 20 pages or 60 s a run,
  cursor on the `ledger` row of `reporting.backfill_progress` (its own `until`, apart from the sales
  kinds; the migration adds the kind to the CHECK). Same rules as the sales backfill: a failed read
  or a write that may pass stops before the cursor; a refused row is logged
  (`reporting.fact-write-failed`, `kind: ledger`), counted and passed over. Reset: delete the
  Market's `ledger` row as the migration role. There is no nightly ledger reconcile (FE-170).
- Net revenue (`reporting.view-marketplace-net-revenue`, key `commission-payouts.settlement.view`,
  platform admin acting as themselves): commission + delivery margin − platform-funded discounts −
  platform-funded cashback − fleet fees, without GST. Only the commission has a source: commission
  charged less what seller-borne refunds gave back (the base is goods without GST, so the commission
  carries none). Delivery margin, platform-funded discounts and cashback are `not-available`
  (`not-reported`: ordering and promotions hold them, no facade carries them; FE-167, FE-168), fleet
  fees `not-recorded` (FE-169). `total` is `{status: 'complete', amount}` only when every component
  is available; otherwise `{status: 'partial', missing}` with NO amount, so a partial sum can never
  be shown as the total (Ali, PR 4 review). Each available component keeps its own amount, so the
  screen shows the commission under its own label. A seller's own cashback is the seller's money
  and never lowers it.
- Seller net earnings (`reporting.view-seller-net-earnings`, key `commission-payouts.earnings.view`,
  the session's seller only, allowed while not approved like its ledger): commission base of the
  range's goods − base of its seller-borne refunds − net commission − net seller cashback. A refund
  the platform bears takes nothing from the seller, so it is not in it; delivery fees are not
  goods and are left out. The base uses the ledger's provisional GST until the tax module gives each
  line's tax, so it can differ slightly from GMV without GST of the sales rollups.
- Readiness ("one week of matching ledger", design: FE-066 of the dashboards upgrade): ready when
  the ledger backfill has finished without refusing a row (`failed_facts = 0`, else
  `backfill-refused-rows`: a refused row is a hole the days may not show), at least
  `READINESS_MIN_MATCHED_SELLER_ORDERS` = 7 seller orders matched across the window (else
  `insufficient-activity`), AND each of the 7 Market days ending yesterday matches. The minimum is
  one a day on average: an empty week matches trivially (0 = 0) and proves nothing, while seven
  matched orders show the subscriber kept up on real traffic. A quiet Market keeps the figures
  withheld (fail-closed) rather than showing them unproven; the constant is in `domain/ledger.ts`.
  The match: every
  seller order the sales facts hold as paid that day with goods above 0 has a `commission` fact that
  day, and every seller order with a `commission` fact that day is held as paid that day (or held as
  never seen paid, a seller order first read after it was cancelled). Chosen over "the subscription
  has been live 7 days" because it detects a lost event, a failed backfill page and a day-boundary
  bug, and it needs no new state. Amounts are not compared: the ledger's base uses the provisional
  tax rate, the sales facts the line's tax. Today is never in the window (rows still arriving). Both
  reads answer the figure as null until ready; the admin answer carries the day counts, the seller
  answer only the flag. The readiness checks the `commission` rows only: `refund-commission` and
  the cashback kinds are trusted to travel with them (same ledger table, same event, same
  backfill), so a lost refund or cashback row is not detected by it (the reconcile, FE-170, would).
- Indexes and growth (Mojtaba, PR 4 review): the backfill pages commission-payouts' ledger by
  `(market_id, id)`; that ledger has no such index today, so its next migration (in its own module)
  should add `(market_id, id)` before the history grows. `reporting.ledger_entries` needs no
  partitioning below about 5M rows; above that, partition by `market_day` month.
- The readiness reads filter by Market, tenant and currency (the known-unpaid lookup too) and
  dedupe the commission (seller order, day) pairs in memory, with no `DISTINCT` in the query.
- Both reads take a range of Market days (at most 13 months, ending today at the latest) and are
  on the KPI facade (`marketplaceNetRevenue`, `sellerNetEarnings`) for PR 6 and PR 8. No HTTP
  endpoint yet.
- Deferred from the PR 4 review: a shared `sessionSellerOf` in `platform/authz` (FE-171) and a
  boundaries rule that lets only `modules/reporting` import `COMMISSION_PAYOUTS_REPORTING_FACADE`
  (FE-172; today the facade's rule `system` is the control, tested per use case).

## Custom range and daily export (dashboards v2, PR 5)

- Every KPI read (admin `dashboard/admin/kpis`, the four marketplace reads behind it, seller
  `reporting/seller/kpis`) takes a preset `period` or a custom range `from` and `to`: Market days
  `YYYY-MM-DD`, both included, `period` absent or `custom` (`domain/period.ts`,
  `parsePeriodQuery` for the shape, `resolvePeriodRequest` on the Market's today).
- Rules: real calendar days (2026-02-30 is `format`), `from` not after `to` (`after-to`), `to` not
  after the Market's today in the Market zone (`future`), and at most 13 calendar months both ends
  included: `from` is no earlier than `to` minus 13 months plus one day, a month end clamped
  (31 March gives 1 March of the year before), so at most 397 days (`too-long`). Each is a 400
  `validation.failed` with `details.fields` `{ path, code }`.
- The previous period of a custom range is as many days just before `from`; `period.id` is
  `custom`. The admin dashboard checks the range once through the facade's `resolvePeriod` (no data
  read) before it asks any section, so a future range is one 400, never a section `error`.
- Exports: `GET reporting/admin/daily/export` (`reporting.export-marketplace-daily`: keys
  `commission-payouts.settlement.view`, `ordering.order.view` and the new
  `reporting.marketplace-report.export`; a platform admin acting as themselves) and
  `GET reporting/seller/daily/export` (`reporting.export-seller-daily`: `ordering.seller-order.view`
  and the new seller key `reporting.seller-report.export`; the session's own seller only, an
  unapproved seller denied). Query: `period` (admin default `7d`, seller `30d`) or `from`/`to`, and
  `format` `csv` (default) or `xlsx`; any other key, `sellerId` included, is `unknown-field`.
- The file is the shared list export's (`platform/list-export`): CSV in UTF-8 with a byte order
  mark, a header row, CRLF, the formula guard on every text cell; XLSX with every cell as text. One
  row per Market day of the range (a day with no fact is zeros), ISO days, money as minor units
  with the currency in its own column. A safe-integer amount is written as a number so a negative
  net is not quoted as a formula. The admin file: GMV with and without tax, refunded goods
  (positive, on the refund day), net sales and the order counts; the seller file: the figures of
  its KPI cards.
- Each download writes one audit row (`reporting.marketplace-daily.exported`, target
  `marketplace-daily`; `reporting.seller-daily.exported`, target the seller) with the period kind,
  the range as the instants of its first day's start and of the day after its last in the Market
  zone, the days, the format and the row count; never a figure. The rows are read and the audit
  row written in one read-write unit (READ COMMITTED), so a refused audit row sends no file
  (`access.unavailable`). No step-up and no rate limit: the files hold daily sums only (FE-178).
- Reads: admin, the existing grouped `daily_seller_sales` read by `(market_id, market_day)`; seller,
  `findMany` on `(market_id, seller_id, market_day)` with `tenant_id` and `currency`. At most 397
  days. No table, migration or index is added.
- The net revenue and net earnings reads of PR 4 (`marketplaceNetRevenue`, `sellerNetEarnings`)
  check their `range` by the same rules (`checkDayRangeFields` calls `parsePeriodQuery` and
  `resolvePeriodRequest`), and their refusal now names the fields too; `MAX_RANGE_MONTHS` has one
  definition, in `period.ts`.
- Days are the Market's, not the seller's own zone (FE-179). Only the daily series is exported
  (FE-180).

## Admin KPI and finance additions (dashboards v2, phase 1, PR 6)

The dashboard composes these into `GET dashboard/admin/kpis` (docs/modules/dashboard/notes.md).
Days are the Market's days (its IANA zone), the period is the existing `period` query (`today`,
`7d`, `30d`, `month`). Rates are basis points (1320 is 13.2%), rounded half up, null when the
denominator is 0.

- Net revenue and take rate (`FinanceAnswer.net`, use case `reporting.view-marketplace-finance-kpis`,
  key `commission-payouts.settlement.view`): the PR 4 net revenue of the period's range and of the
  previous range, read from `daily_ledger` in a second read-only unit (when it fails, `net` is null
  and GMV still answers). Behind the same readiness as PR 4: until `readiness.ready` both figures
  and both take rates are null. Take rate = net revenue ÷ GMV without GST of the same range (the
  sales rollup's `goods_amount - goods_tax_amount`, gross of refunds, as GMV is defined). It is
  `complete` only when net revenue's total is complete; while a component is missing it is
  `partial`: computed from the available components only, with their sign (`basis`, today only
  `commission`), and the `missing` ones named, so the screen labels it "commission only" and never
  shows it as the take rate. `no-sales` with no GMV. A partial total still has no amount. Deltas:
  `commission` (minimum base 100.00), `total` (`na` unless both periods are complete), and
  `takeRateBp` in basis points of difference (`na` unless both rates have the same status and
  basis).
- Orders by status (`reporting.view-marketplace-order-status`, key `ordering.order.view`, platform
  admin acting as themselves, counts only): the seller orders with `paid_day` in the period
  (`seller_orders` only, Market currency), each in one bucket by where it stands now, by priority
  cancelled (`cancelled_at` set) > refunded (not cancelled, at least one succeeded refund in
  `refunds`, partial or whole) > delivered > shipped (not delivered) > to ship. The buckets add up
  to `paid`; `cancelledRateBp` and `refundedRateBp` are of `paid`. The answer carries the period's
  instant window (`windowOf`: start of its first Market day to the start of the day after its
  last) for the dashboard's dispute rate.
- Query shape (Mojtaba): four `count`s of `seller_orders` on `(market_id, paid_day, seller_id)`
  with the state columns filtered on the rows; one `groupBy seller_order_id` of `refunds` with
  `refund_day >= range.from` on `(market_id, refund_day, seller_id)` (a refund is never before its
  payment, so none paid in the range is missed); then the states of those seller orders paid in the
  range by primary key, 5 000 ids per `IN` list. No join, no raw SQL. The refunds read grows with
  the refunds since the range's first day (at most 13 months of them).
- Measured (Mojtaba's review, 1.2 M seller orders, 40 k refunds, 200 k listings with 600 k variants;
  plans in the design folder's `shots-build/pr6-admin-kpis/query-plans.md`): a whole admin
  dashboard load of a 30-day period takes about 0.4 s, 25 statements through the 10-connection
  pool, every section well inside its 1.5 s limit, so no index was added. The counts read the heap
  (a covering index is FE-20261124-seller-orders-covering-index), the out-of-stock count is a NOT EXISTS anti join (partial index
  FE-20261124-offer-variant-in-stock-partial-index), and a `first_refunded_at` column would replace the refunds read (FE-20261124-reporting-first-refunded-at). The read-only
  unit opens no transaction, so the counts are separate snapshots and may drift by a few orders.
  A derived bucket that drifts below zero is clamped to 0 (`orderStatusOfDrifted`) and logged as
  `reporting.order-status.drift-clamped` with the shortfall per bucket and `paid` (counts only); the
  answer is never an error for drift (Mojtaba's ruling). `orderStatusOf` stays strict for a
  consistent set.
- Same-day share (`sameDayShare`): seller orders paid on a Market day of the period (`paid_day`, the
  Market's zone) whose buyer chose `delivery_method = 'same_day'` (#1310), ÷ every seller order
  paid in it, cancelled and refunded ones included; basis points. Below 5 paid (`MIN_COUNT_BASE`)
  it is `{status: 'not-enough-data', paid, minimum: 5}`. While a paid seller order of the period
  has no method yet (recorded before the column, until the backfill's delivery pass) it is
  `{status: 'not-available', reason: 'method-unknown', unknownMethod}`, never a share that counts
  it as not same-day. It comes from the same read as `paid` (a `groupBy delivery_method`), so it
  adds no statement (measured in query-plans.md: not slower than the old count, 13 months 115 ms).
- Supply and health numbers come from their owners' facades, counts only, each a new use case with
  a permission rule, platform admins acting as themselves, in one read-only unit, `access.unavailable`
  when the dashboard stopped waiting or the store failed:
  - `search.count-live-listings` (key `catalog.product.view`): active listings = documents of
    `search.offer_documents` in the Market (published, listed, the seller may sell: what a shopper
    can find); out of stock = those with no `offer_variant_documents` row in stock (inventory's
    `in-stock` or `low`). Out-of-stock rate = out of stock ÷ active, computed in the dashboard. Two
    counts side by side with no transaction, so a write between them can move them slightly.
  - `certification.count-expiring-certificates` (key `certification.seller-certificate.view`):
    approved seller certificates whose validity boundary is after now and no later than the start
    of the Market day after the 30th Market day from today (`expiringWindowEnd`), on the partial
    index `seller_certifications_market_id_approved_boundary_at_idx`. Product certificates are not
    counted yet (FE-20261124-admin-expiring-product-certificates).
  - `commission-payouts.count-payout-holds` (existing, key `commission-payouts.settlement.view`):
    the active holds. Their amount is `not-available` (`not-recorded`): a hold carries no amount and
    no module records what it keeps (FE-20261124-admin-payout-hold-amount).
  - `commission-payouts.count-disputes-opened` (key `commission-payouts.dispute.view`): chargebacks
    (not a Stripe inquiry) opened in the window, on `dispute_cases_bucket_idx` with all five buckets
    listed. Dispute rate = chargebacks opened in the period ÷ seller orders paid in the period (a
    case is per order, the denominator per seller order, as the KPI defines it).

### Buyer-first flags: rules for what reads them (Hassan, 24 Nov 2026, PR 1323)

`seller_orders.buyer_first_order` and `buyer_first_with_seller` sit beside the order ids, and a seller
knows the buyer behind each of its own orders. Hard rules for the dashboards that read them (the
new/returning card, phase 2 cards PR):

- Seller-facing counts use `buyer_first_with_seller` only. `buyer_first_order` appears only in
  admin Market-wide totals, never in a seller's view (it would tell a seller that a named buyer has
  bought elsewhere).
- Counts below a minimum group size (5, to be confirmed by the product owner) are hidden on any
  section that breaks down by seller.
- A per-order flag never appears in an order detail, a list or an export.
- The reads return counts only. The flags are statistics: never an input to a promotion
  eligibility, fraud or access decision (a buyer can look new again with another account).
- Erasure and retention: both claim tables (`ordering.buyer_first_orders`,
  `ordering.buyer_first_seller_orders`) hold the same account id as `orders.account_id`; list them in
  the retention inventory. Their foreign keys are `ON DELETE RESTRICT`: an order-pruning job must
  delete the claims first (it needs a DELETE grant), and deleting a claim would make a later order
  wrongly "first".

## Shopping funnel: nightly engagement snapshot (dashboards v2, phase 2)

- Population (phase plan, one population): signed-in customers who have not switched
  personalization off. engagement records an account's behaviour only while its switch is on and
  deletes it in the same unit when it is switched off, so every account with an event of the day is
  in the population. Guests are never counted. Steps, each a count of distinct accounts of the Market
  day that did the step AND every step before it: viewed a product (`product-viewed`), added to the
  cart (`added-to-cart`), placed an order (an `ordering.orders` row created that day: there is no
  checkout event), paid (one of those orders confirmed). An account that orders the day after it
  viewed is not in either day's checkout step.
- `reporting.snapshot-daily-engagement` (job, hourly; the scheduler has no wall clock): for each
  Market day of the last 28 that ended at least 2 hours ago in the Market's zone (the 30-minute
  payment window plus a margin) and has no row, reads ordering's `checkoutsStarted` (accounts with an
  order in the day, each with a paid flag, at most 5,000) and hands it unchanged to engagement's
  `shoppingFunnel` (rule `system`), which matches it against its own population and answers four
  counts. The row is written once by the hourly job, at least 2 h after the Market day ends, and
  never changed. A day an owner cannot count is logged by day and reason and retried next run; the
  run then fails so the scheduler reports it.
- Over a cap (Mojtaba L1): a day with more than 5,000 checkout accounts (ordering) or more than
  100,000 accounts in a step (engagement) is not written, never written short. The adapter marks
  such a failure `overCap`, and the job asks that day only once per worker process (an in-process
  set; a restart tries it once more), so it does not rescan it every hour; later runs report it as
  `cappedDays` in their summary log. What to do at the cap: page `checkoutsStarted` by account id
  (keyset) and sum the checkout and paid steps over the pages (they add up over disjoint sets of
  accounts), and count the viewed and carted steps in SQL (`count(DISTINCT account_id)`) instead of
  reading the ids (FE-20261125-reporting-funnel-checkouts-paging). Then backfill the capped days
  while they are inside the 28-day look-back.
- Tenant (Mojtaba L2): engagement's `accountsWith` filters by Market only, like every other read of
  `behaviour_events`; the table key and the reads take no tenant until tenants become real
  (FE-20261125-reporting-funnel-tenant-scope).
- Ordering of the purge: the hourly job writes a day once, at least 2 h after it ends; engagement's purge
  deletes guest behaviour after 30 days and account behaviour after 12 months, and the look-back (28
  days) stays inside both, so the behaviour of a day is still there when its row is written (guests
  are not in the funnel today; the window keeps room for a later guest-inclusive count).
- Privacy (for Hassan to confirm): the table holds counts per (Market, day) only, no account, guest,
  offer or seller column (the reporting-facts db-spec scans for such columns). The account ids of
  the checkouts exist only inside one call of `FacadeEngagementSources` (from ordering's facade to
  engagement's), never stored, logged or returned. The application role has SELECT and INSERT only,
  so an opt-out or an erasure never needs to touch reporting, and the counts of past days survive it
  (db-spec `reporting-engagement`). Only `FacadeEngagementSources` calls the two facade methods that
  carry the ids (contract spec `funnel-account-handoff`). The read hides a step under 5 customers
  (and every step after it, so a hidden count cannot be worked out from a rate in the same answer)
  and answers `not-enough-data` below 20 viewers (phase plan's minimum of 20 shoppers). Marketplace
  totals only, admin only.
- Residual risk (Hassan L1, accepted): the suppression protects a single answer only. Differencing
  two overlapping custom ranges (for example days 1 to 30 and days 1 to 29) can recover one day's
  count below 5. Accepted because the viewer already holds `ordering.order.view` and so sees
  order-level data, which tells more about a person than a daily count does. The funnel card's "?"
  help text (phase 2 cards PR) must not claim that small numbers are never shown; it should say that
  steps under 5 are hidden in each answer.
- Read: `reporting.view-marketplace-shopping-funnel`, key `ordering.order.view` (the same key as the
  other order-count sections; no new key), platform admin acting as themselves.
- Deferred: the seller's product funnel (FE-20261125-dashboards-seller-product-funnel), distinct
  customers over a whole period (FE-20261125-dashboards-funnel-distinct-over-period), paging past
  5,000 checkouts a day (FE-20261125-reporting-funnel-checkouts-paging), the tenant in the key and
  the reads (FE-20261125-reporting-funnel-tenant-scope), and the product owner's check that the
  privacy policy covers aggregate statistics (FE-20261125-legal-privacy-policy-aggregate-statistics).


## Zero-result searches: nightly snapshot (dashboards v2, phase 2)

- Design choice (the simplest safe one): nothing about a person crosses a module. search notes,
  server-side in `search.search-products` when called by the storefront route, the folded text of a
  plain text search whose first page showed nothing, per UTC quarter hour (`search.zero_result_queries`,
  no session or account). engagement counts, inside its own module, the distinct signed-in customers
  with personalization on who searched a given text on a given day. reporting hands the texts from
  one to the other and keeps only texts and counts. Compared with #1328 no id passes through
  reporting at all: the hand-off is texts in, counts out.
- `reporting.snapshot-daily-searches` (job, hourly): for each Market day of the last 28 that ended at
  least 2 hours ago in the Market's zone and has no `search_snapshot_days` row, asks search's
  `zeroResultTexts` (the day's noted texts, at most 2,000, those noted in the most quarter hours
  first, so a flood of one-off texts cannot push out the texts many shoppers miss) and hands them to
  engagement's `searchShoppers`, which answers only texts searched by at least ten distinct customers
  that day (its own constant, not the caller's). The day row and the kept texts are written once, in
  one unit. A day with no qualifying text still gets its day row (`query_count` 0). A day over
  engagement's cap (100,000 text-account pairs) is asked once per process (`cappedDays`), like the
  funnel.
- Flag semantics: a search event of the day counts for a text when search noted that text as
  zero-result at least once that day. A text that found nothing in the morning and something after
  a product was published at noon counts for the whole day; the card's "?" should say "searches on
  days it returned no results".
- Suppression (Hassan's rule from the phase plan): a text is written only when at least ten distinct
  signed-in customers searched it that Market day; below ten its words never reach reporting (the
  engagement count drops it, `keptZeroResultRows` drops it again, the table CHECK refuses it).
  Over a period the read sums the kept days, so `searcherDays` is customer-days; a text ten people
  searched over a month but never ten in one day is never shown
  (FE-20261125-dashboards-zero-result-distinct-over-period). Guests are never counted (a new guest
  cookie would be a new "person"). search also never notes a text that may name or reach a person:
  more than 50 characters, an `@`, `://` or `www.`, or five digits or more in all (phone, order and
  card numbers, GTINs).
- Survives opt-out and erasure: rows are written once (SELECT and INSERT only) and name no one; a
  later switch-off deletes the behaviour in engagement and leaves the day's row (db-spec
  `reporting-zero-result-searches`).
- Only reporting's `FacadeSearchSources` calls `searchShoppers` and `zeroResultTexts`, and only the
  storefront route sets `noteZeroResult` (never the buyer assistant's facade, whose texts a model
  chooses): contract spec `zero-result-search-handoff`.
- Read: `reporting.view-marketplace-zero-result-searches`, key `catalog.product.view` (what shoppers
  miss is a catalogue gap; the same key as the live-listings health number; no new key), platform
  admin acting as themselves. Top ten by searches, then by text; `not-enough-data` when no text
  qualifies. The text is data: the admin card must render it as a plain text node, never HTML or
  markup and never a link (Hassan I4).
- `searches` counts every search of the text by the counted population (signed-in customers with
  personalization on) on each kept day, including searches of that day that did find something
  (the flag is per text and day, see above; Hassan I3). The DTO description says so.
- Both `daily_zero_result_searches.query_text` and search's `zero_result_queries.query_key` refuse,
  by CHECK, an `@`, `://` or `www.` (any case) as well as the length rule (Mojtaba L5, Hassan I1);
  the digit rule stays in the application.
- Accepted residual risks (PR 1342 review):
  - Hassan L1: a name or street address with four digits or fewer passes the text rules and can sit
    in search's notes for up to 35 days; it reaches reporting and the dashboard only when ten
    distinct signed-in customers searched that exact text on one day.
  - Hassan L2: many accounts or a botnet can fill a day with one-off zero-result texts and crowd the
    2,000-text read. The texts are taken most noted quarter hours first, and search keeps a small
    per-process recent-notes cache so a repeat in the same quarter hour does not reach the database
    (Mojtaba L1); a row-count alert on `search.zero_result_queries` comes with the monitoring work.
  - Hassan L3: the text is what clients typed; any text ten accounts report as searched on one day
    can show on the admin card. A control for an admin to hide a text is
    FE-20261125-dashboards-zero-result-hide-text.
  - Mojtaba 7: a day above engagement's cap (100,000 text-account pairs) is skipped (no day row);
    once it leaves the 28-day look-back it is lost for good. The covering index that would let the
    cap rise is FE-20261125-engagement-search-pairs-covering-index.
- Deferred: distinct searchers over a whole period
  (FE-20261125-dashboards-zero-result-distinct-over-period), the mock's "Top searches" card with a
  no-result share (FE-20261125-dashboards-top-searches-no-result-share), a 13-month purge of the rows
  (FE-20261125-reporting-zero-result-searches-retention).

## Discount cost (dashboards v2, phase 2)

`reporting.view-marketplace-discount-cost` (keys `commission-payouts.settlement.view` and
`promotions.promotion.manage`, both; a platform admin acting as themselves) answers the discount cost of a period for the admin dashboard. Nothing
is stored in reporting: it asks promotions' reporting facade (`PROMOTIONS_REPORTING_FACADE`,
`promotions.sum-discount-cost`) for the instants of the period's Market days and of the period
before (`windowOf`, the Market's zone, never UTC days), in the Market's currency, with the caller's
own context, so promotions checks the same key again. Two grouped reads (at most 8 groups each)
over the partial index `promotions.redemptions_confirmed_idx`; a live read is cheap, so no nightly
snapshot was added. `domain/discount-cost.ts` checks that the shares and kinds add up (a mismatch
throws and the section answers `error`, never a guessed number), holds the amounts back below five
discounted orders, and gives the change with the money base of the other KPIs (100.00). A refusal
of the key from promotions passes through (the dashboard leaves the section out); any other failure
is `access.unavailable`.

Attribution: a discount counts on the Market day its order's payment was confirmed (the redemption's
`confirmed_at`, set by `ordering.order-paid.v1`), like GMV by paid day. A later refund or
cancellation after payment moves it from `amount` to `released` of the same period (the redemption
is released for the whole order), so an old period's cost can fall after the fact; the card shows
the figure as of now.

Privacy and residual risk: a kind used by 1 to 4 redemptions has every figure null, and `released`
is null for 1 to 4 orders, so one order's discount is not read off the card; below five discounted
orders the whole answer is `not-enough-data`. Differencing stays possible: a viewer who compares two
overlapping custom ranges, or the total against the kinds shown, can still narrow a small group down.
That is accepted, because the viewer is a platform admin who holds both the money key and promotion
management and can already see each promotion's spend in promotions; the hiding guards against a
glance, not against that viewer. The kinds' shares use the largest remainder (ties to the earlier
kind), so the shares shown add up to 10000 basis points.

## Abandoned carts (dashboards v2, phase 2, nightly snapshot)

- Table `reporting.daily_abandoned_carts`, one row per (Market, day): `cart_count` and an approximate
  value in the Market's currency. Written by `reporting.snapshot-abandoned-carts` (rule `system`,
  hourly job of the same name) through cart's `CartReportingFacade.abandonedCarts`
  (`cart.count-abandoned-carts`, rule `system`).
- Definition: an ACTIVE cart (guest or signed-in; never a merged one) with at least one line, no
  order mark (a paid order cleared lines from it and the buyer has not changed it since; the same
  "not ordered" as the cart reminder), last changed at or before 24 hours before the end of the
  Market day (absolute hours, the Market's zone, the injected Clock). It is a level, not a flow: the
  read shows the period's latest snapshot day (`asOfDay`) against the latest day of the period
  before, never a sum of days.
- When: once yesterday ended at least 2 h ago in the Market's zone, on the first hourly run, and
  only yesterday. The carts are read as they are at that run, so a cart changed between midnight and
  the run is left out (slightly fewer, never more). An older day is never written late, since a
  cart's past state cannot be read: a day missed while the worker was down stays without a row and
  the card shows the day before it.
- Value: each line's quantity times its price when added or last changed (`price_at_add`), summed.
  Approximate by design (prices change; the card says "about"); it is never the price now and never
  a basis for money decisions. When any line is in another currency than the Market's, the value is
  null (no conversion) and the count is still written; the job logs the currencies only.
- No cap (Mojtaba M1, option A): cart answers with two aggregate statements in one read-only unit,
  scoped by Market and tenant at both levels (Hassan L1): the lines grouped by currency and quantity
  with their prices summed (value = quantity × that sum; a line holds 1 to 999 units, so the groups
  stay few), and a count of the carts that have a line. No row reaches memory and no raw SQL is
  used. The unit opens no transaction (ADR-0025), so a cart changed between the two statements can
  make the count and the value differ by that cart: within "about". If the statements get slow at
  volume: FE-20261125-reporting-abandoned-carts-paging.
- Privacy: counts and a sum only. No cart, account or guest id leaves cart's adapter; nothing is
  logged but the day, a reason code and currencies. The table has no account, customer, guest,
  offer or seller column (db-spec `reporting-abandoned-carts`); SELECT and INSERT only for the
  application role. The read answers `not-enough-data` below 5 carts on the latest day, with no
  count and no value (a value of one or two carts would be one person's cart). The same residual
  risk as the funnel (Hassan L1): two overlapping custom ranges can show two different latest days,
  each over 5; no single small count is ever answered.
- Read: `reporting.view-marketplace-abandoned-carts`, key `ordering.order.view` (no new key),
  platform admin acting as themselves; `GET dashboard/admin/kpis` section `abandonedCarts`.
- "Reminders sent" (in the design mock) is deferred: the cart reminder exists, but
  `notifications.cart_reminders` records a stage when it is taken, before consent and address are
  checked, so counting it would overstate the mails sent
  (FE-20261125-dashboards-abandoned-carts-reminders-sent).
