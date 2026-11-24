# reporting: physical data design (dashboards upgrade, phase 3)

Owner: `reporting`. Schema `reporting`. Migration `20261122200000_reporting_daily_rollups`. Module
notes: `docs/modules/reporting/notes.md`.

## Tables and expected size

| Table | Key | Rows | Growth (per year at 100k paid seller orders) |
|---|---|---|---|
| `seller_orders` | `(market_id, seller_order_id)` | one per seller order reporting heard of | about 100k |
| `refunds` | `(market_id, refund_id)` | one per succeeded refund | about 3k (refund rate 2 to 3 %) |
| `sales_entries` | `(market_id, kind, source_id, category_id)` | one per seller order and category, plus one per refund and category | about 150k (1.5 categories per seller order) |
| `daily_seller_sales` | `(market_id, market_day, seller_id, currency)` | one per active seller per day | about 365 × active sellers (100 sellers: 36.5k) |
| `daily_category_sales` | `(market_id, market_day, seller_id, category_id, currency)` | one per seller, category and day with sales | about 2 × `daily_seller_sales` |
| `inbox` | `(event_id, handler)` | one per consumed event and handler | about 6 per seller order (600k) |
| `ledger_entries` | `(market_id, entry_id)` | one per commission, refund-commission and seller-cashback ledger row (PR 4 of dashboards v2) | about 160k (1.5 lines per seller order, plus refunds and cashback) |
| `daily_ledger` | `(market_id, market_day, seller_id, currency, kind)` | one per active seller, day and ledger kind | about 1.2 × `daily_seller_sales` (commission every day, the other kinds rarely) |

`seller_orders` also holds `delivery_method` and `delivery_state` (a region code of at most 3
characters, never a postcode; migration `20261124010000_reporting_seller_orders_delivery`): nullable
attributes added without a default (catalog-only change, CHECKs added NOT VALID then validated), not
rollup keys, with no index until a read needs one (the orders-by-state card of phase 2 reads a range
of paid days already served by `(market_id, paid_day, seller_id)`).

All rows are small (under 200 bytes), so even 10x this volume stays under a few GB with indexes.

## Access paths

- Rebuild one seller day: the primary key prefix `(market_id, market_day, seller_id)` on both
  rollups and on `sales_entries` (index `market_id, market_day, seller_id`); the four day indexes of
  `seller_orders` combine (BitmapOr) for its OR.
- Admin KPIs over a range: primary key range on `(market_id, market_day)`.
- Seller KPIs over a range: `(market_id, seller_id, market_day)` on both rollups.
- Top categories of a range: `(market_id, market_day, category_id)`.
- Net revenue of a range: primary key range on `(market_id, market_day)` of `daily_ledger`; a
  seller's net earnings: `(market_id, seller_id, market_day)`. Rebuild one seller day of it:
  `ledger_entries (market_id, market_day, seller_id)`.
- Ledger readiness (7 days): `seller_orders (market_id, paid_day, seller_id)` and
  `ledger_entries (market_id, market_day, seller_id)`, filtered on kind; then the seller orders
  not paid in the window by primary key. `ledger_entries (market_id, seller_order_id)` serves
  lookups by seller order.

## Retention and later work

- `ledger_entries` and `daily_ledger` hold ids and money only; like the rest, derived data the
  ledger backfill rebuilds (reset its `backfill_progress` row).
- The rollups and facts are derived data: kept as long as the dashboards show history, rebuilt by
  the backfill if lost. No personal data is stored (no customer, account or address id, no postcode; the delivery state is a region code only).
- `inbox` rows have no purge yet, the same as the other modules' inboxes; the shared inbox
  retention, when it is added, covers this one too.
- Revisit partitioning `sales_entries` and the rollups by `market_day` when a table passes about
  50 million rows.
