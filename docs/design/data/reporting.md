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
| `seller_monthly_goals` | `(market_id, seller_id, month)` | one per seller and month a goal was set for (dashboards v2 phase 2) | at most 12 × sellers who set goals (100 sellers: 1.2k) |

`seller_orders` also holds `delivery_method` and `delivery_state` (a region code of at most 3
characters, never a postcode; migration `20261124010000_reporting_seller_orders_delivery`): nullable
attributes added without a default (catalog-only change, CHECKs added NOT VALID then validated in the
same transaction, so the ADD COLUMN's exclusive lock is held through the quick validation of all-null
rows), not
rollup keys, with no index until a read needs one (the orders-by-state card of phase 2 reads a range
of paid days already served by `(market_id, paid_day, seller_id)`).

`seller_orders` also holds `buyer_first_order` and `buyer_first_with_seller` (migration
`20261124020100_reporting_seller_orders_buyer_first`, dashboards v2 phase 2): the two flags ordering
freezes at payment, nullable without a default (catalog-only change, CHECK added NOT VALID then
validated in the same transaction, which holds the ADD COLUMN's exclusive lock through the quick scan
of all-null rows: no lock is avoided, none is needed): both or neither, only with `paid_at`, a first order is the first with its seller), not
rollup keys and with no index until the new-and-returning card reads them. No customer or account id
is stored anywhere in reporting.

`seller_monthly_goals` (migration `20261125010000_reporting_seller_monthly_goals`, dashboards v2
phase 2) is the one table of reporting that is NOT derived data: a seller's own sales goal for a
calendar month of the Market's zone, set through `reporting.set-seller-monthly-goal`. `month` is the
first day of the month (CHECK: day 1); `amount` is minor units above zero and below 10^15, with its
`currency` (the Market's); `version` starts at 1 and every change raises it (the use case refuses a
stale version; the store's first insert is `ON CONFLICT DO NOTHING`, so a race never aborts the
unit). The application role has SELECT, INSERT and column UPDATE on `currency`, `amount`,
`version` and `updated_at`: the key never changes and nothing is deleted. It stores no account
id (reporting's rule, checked by `reporting-facts.db-spec.ts`): who set a goal is in the audit row.
No index beyond the primary key (one point read per seller and month). Its down migration loses
the goals (no backfill brings them back).

- A goal stored in another currency than the Market's (after a Market currency change) is ignored
  by the read: the seller sees no goal until they set one again (L3).
- The forecast reads the rollups, which lag the events by up to the worker's delay, while the time
  elapsed is exact: early in a day it reads slightly low (L4).
- Growth: about one row per seller per month a goal is set; past months are never deleted (L5).

All rows are small (under 200 bytes), so even 10x this volume stays under a few GB with indexes.

## Access paths

- Rebuild one seller day: the primary key prefix `(market_id, market_day, seller_id)` on both
  rollups and on `sales_entries` (index `market_id, market_day, seller_id`); the four day indexes of
  `seller_orders` combine (BitmapOr) for its OR.
- Admin KPIs over a range: primary key range on `(market_id, market_day)`.
- Seller KPIs over a range: `(market_id, seller_id, market_day)` on both rollups.
- Top categories of a range: `(market_id, market_day, category_id)`.
- The month-end forecast: the admin month to date and the month before are two `dailyTotals` ranges
  (primary key range); the seller's are two `daily` ranges on `(market_id, seller_id, market_day)`
  plus one primary-key read of `seller_monthly_goals`.
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
- `seller_monthly_goals` is authored data: keep it like the other modules' settings; a goal is
  changed in place, never removed yet (FE-20261125-seller-goal-remove).
- The rollups and facts are derived data: kept as long as the dashboards show history, rebuilt by
  the backfill if lost. No personal data is stored (no customer, account or address id, no postcode; the delivery state is a region code only).
- `inbox` rows have no purge yet, the same as the other modules' inboxes; the shared inbox
  retention, when it is added, covers this one too.
- Revisit partitioning `sales_entries` and the rollups by `market_day` when a table passes about
  50 million rows.
