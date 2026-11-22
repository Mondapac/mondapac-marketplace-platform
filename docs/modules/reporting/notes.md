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
