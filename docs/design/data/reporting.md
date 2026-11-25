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
| `daily_engagement` | `(market_id, market_day)` | one per Market day (dashboards v2, phase 2: the shopping funnel) | 365 per Market |
| `search_snapshot_days` | `(market_id, market_day)` | one per Market day whose zero-result searches were written (dashboards v2, phase 2) | 365 per Market |
| `daily_zero_result_searches` | `(market_id, market_day, query_text)` | one per Market day and text the search found nothing for and at least ten customers searched | a few per day at launch; at most 2,000 per day by construction |

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

`daily_engagement` (migration `20261125020000_reporting_daily_engagement`, dashboards v2 phase 2):
four counts per Market day (`viewed_count`, `carted_count`, `checkout_count`, `paid_count`) of
distinct signed-in customers with personalization on, each within the step before (CHECK:
`viewed >= carted >= checkout >= paid >= 0`), and `recorded_at`. Written once by the hourly
snapshot job, at least 2 h after the Market day ends (`createMany` with skip-duplicates on the primary key), and never changed: the application
role has SELECT and INSERT only, no UPDATE or DELETE, so a customer's opt-out or erasure never needs
to touch it. No account, guest, offer or seller column.

`search_snapshot_days` and `daily_zero_result_searches` (migration
`20261125030100_reporting_zero_result_searches`, dashboards v2 phase 2): per Market day, the day row
(`query_count`, `recorded_at`) and one row per folded text (`query_text`, 2 to 50 characters) the
storefront search found nothing for that day (search's own note, `search.zero_result_queries`) and
that at least ten distinct signed-in customers with personalization on searched that day
(engagement's count): `searcher_count` (CHECK `>= 10`) and `search_count` (CHECK `>= searcher_count`).
A text below ten is never written. The day row and its query rows are inserted in one unit by the
hourly snapshot (the day row first, skip-duplicates, so a second run writes nothing) and never
changed: SELECT and INSERT only. No account, guest or session column; the column names avoid
`account`, `customer`, `buyer` and `shopper` (the reporting-facts db-spec scans for them). No foreign
key between the two tables (Prisma models them apart; the unit writes both).

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
- Shopping funnel: the snapshot's look-back (28 days) and the read of a period and the one before
  are primary key ranges on `(market_id, market_day)`.
- Zero-result searches: the snapshot's look-back reads `search_snapshot_days` by its primary key
  range; the read of a period reads both tables by `(market_id, market_day)` ranges (at most 13
  months of a few rows a day).
- Ledger readiness (7 days): `seller_orders (market_id, paid_day, seller_id)` and
  `ledger_entries (market_id, market_day, seller_id)`, filtered on kind; then the seller orders
  not paid in the window by primary key. `ledger_entries (market_id, seller_order_id)` serves
  lookups by seller order.

## Retention and later work

- `ledger_entries` and `daily_ledger` hold ids and money only; like the rest, derived data the
  ledger backfill rebuilds (reset its `backfill_progress` row).
- The rollups and facts are derived data: kept as long as the dashboards show history, rebuilt by
  the backfill if lost. No personal data is stored (no customer, account or address id, no postcode; the delivery state is a region code only).
- `daily_engagement` is NOT rebuildable: the behaviour behind a day is deleted by opt-out, erasure
  and engagement's retention purge (guests 30 days, accounts 12 months). It is aggregate only and
  kept as long as the dashboards show history (custom ranges reach 13 months); a lost row stays
  lost, a down migration loses the history beyond the 28-day look-back.
- `daily_zero_result_searches` is NOT rebuildable either (search keeps its notes 35 days, engagement
  its behaviour 12 months at most); aggregate only (a text at least ten customers searched). No purge
  yet: a 13-month purge is FE-20261125-reporting-zero-result-searches-retention.
- `inbox` rows have no purge yet, the same as the other modules' inboxes; the shared inbox
  retention, when it is added, covers this one too.
- Revisit partitioning `sales_entries` and the rollups by `market_day` when a table passes about
  50 million rows.
