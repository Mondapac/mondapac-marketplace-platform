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
  (a covering index is FE-192), the out-of-stock count is a NOT EXISTS anti join (partial index
  FE-193), and a `first_refunded_at` column would replace the refunds read (FE-191). The read-only
  unit opens no transaction, so the counts are separate snapshots and may drift by a few orders.
  A derived bucket that drifts below zero is clamped to 0 (`orderStatusOfDrifted`) and logged as
  `reporting.order-status.drift-clamped` with the shortfall per bucket and `paid` (counts only); the
  answer is never an error for drift (Mojtaba's ruling). `orderStatusOf` stays strict for a
  consistent set.
- Same-day share (`sameDayShare`): same-day deliveries ÷ seller orders paid in the period. It needs
  the delivery method on `seller_orders`, which reporting does not hold yet, so it answers
  `{status: 'not-available', reason: 'not-reported'}`, never 0. `sameDayShareOf` already takes the
  two counts; it is wired once the delivery method column lands (dashboards v2, phase 1, PR 3).
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
    counted yet (FE-190).
  - `commission-payouts.count-payout-holds` (existing, key `commission-payouts.settlement.view`):
    the active holds. Their amount is `not-available` (`not-recorded`): a hold carries no amount and
    no module records what it keeps (FE-189).
  - `commission-payouts.count-disputes-opened` (key `commission-payouts.dispute.view`): chargebacks
    (not a Stripe inquiry) opened in the window, on `dispute_cases_bucket_idx` with all five buckets
    listed. Dispute rate = chargebacks opened in the period ÷ seller orders paid in the period (a
    case is per order, the denominator per seller order, as the KPI defines it).
