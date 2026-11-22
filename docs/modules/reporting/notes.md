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

## Tables (`20261122110000_reporting_daily_rollups`)

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
