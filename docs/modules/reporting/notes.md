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
  after a recorder fix: an operator deletes both of the Market's rows of
  `reporting.backfill_progress` as the migration role (both, so the kinds keep one window end); the next tick starts again with a new `until`. There is no admin screen for
  this yet (FE register, «پیشرفت backfill گزارش در پنل ادمین»).
- The nightly reconcile's counter is now `failedFacts` (it always counted facts, not batches).
- Follow-up (Hassan, PR 12 L3): `isFactRefusal` treats any `RangeError` or `TypeError` as a
  refusal; a reporting-owned refusal error class would keep a future programming error from being
  passed over (FE register, «خطای ردّ ویژهٔ reporting»).


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
  (`access.unavailable`). No step-up and no rate limit: the files hold daily sums only (FE-172).
- Reads: admin, the existing grouped `daily_seller_sales` read by `(market_id, market_day)`; seller,
  `findMany` on `(market_id, seller_id, market_day)` with `tenant_id` and `currency`. At most 397
  days. No table, migration or index is added.
- Days are the Market's, not the seller's own zone (FE-173). Only the daily series is exported
  (FE-174).
