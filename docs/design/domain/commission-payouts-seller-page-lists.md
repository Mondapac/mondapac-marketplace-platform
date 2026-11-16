# As built: seller page ledger and payout holds lists (lists 27 and 28, 2026-11-16)

Two compact super lists of the admin seller page (super list plan phase 4): search, filters,
sort, export and paging, without views or saved filters. Both need
`commission-payouts.settlement.view`, are admin only and read only. Releasing a hold keeps its
own route, key (`payout-hold.release`) and step-up. The older cards' queries keep working.

## Ledger (27): `GET /commission-payouts/admin/sellers/:sellerId/ledger`

- One row per `ledger_entries` row of the seller in the Market. `totals` (and the balance) cover
  every row of the seller, whatever the filter. An unknown seller has an empty ledger.
- **Filters:** `kind`, `side` (credit or debit, a set of kinds), `q` (an order or seller order id,
  exact, matching either), `from`/`to` on the recorded time (`to` excluded), `minAmount`/`maxAmount`
  in minor units.
- **Sort:** recorded (default, newest first), occurred, amount; the id breaks ties.
- **Paging:** page numbers with a total (`pageSize` 1 to 100, default 25, up to row 10,000) or
  Previous/Next with `cursor` and `limit` (default 50), newest recorded first only. The older card
  sends `limit` and `cursor`, so it gets Previous/Next as before.
- **Row action:** `open-order`.
- **Export** `.../ledger/export`: CSV or XLSX; `ids` (at most 200, each a row of this seller in the
  Market, else `commission-payouts.ledger-entry-not-found`) or the filter keys with sort and
  direction, at most 10,000 (`batch.too-large` with the total). Base columns: recorded, kind (the
  panel's words), direction, amount (a decimal of the currency), currency, order id, seller order
  id; optional: occurred, order line, rate, base, source, entry id.

## Payout holds (28): `GET /commission-payouts/admin/sellers/:sellerId/payout-holds`

- The seller must be the Market's (`commission-payouts.seller-not-found`, or `unavailable` when
  sellers cannot answer). `counts` gives active and released holds of the seller.
- **Filters:** `status` (active, released), `reason`, `origin` (admin, system), `scope` (seller,
  order), `sellerOrderId` (exact), `from`/`to` on the placement.
- **Sort:** active-first (default: active holds, then the newest released; ascending flips both),
  placed, released (unreleased last); the id breaks ties.
- **Paging:** page numbers (default and maximum 100 to a page, what the older card shows in one
  answer) or Previous/Next, newest placement first.
- **Row actions:** `open-order` (a hold on one seller order); `release` on an active hold for a
  caller holding `payout-hold.release` (asked through the probe use case; a failing probe offers
  nothing).
- **Export** `.../payout-holds/export`: as the ledger's; base columns placed, status, reason (the
  panel's words), placed by, covers, seller order id, released; optional release reason, hold id.

No new index: both lists read one seller's rows through `ledger_entries (market_id, seller_id,
recorded_at DESC, id DESC)` and `payout_holds_seller_placed_idx`; other sorts sort a seller's rows.
