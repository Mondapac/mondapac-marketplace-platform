# As built: the admin Disputes list (list 23, 2026-11-16)

The Market's card dispute cases (chargebacks) as a super list (super list plan phase 4): views by
bucket with counts, search, filters, sort, page numbers or Previous/Next, row actions and an
export. Read only: the decision on who bears a lost dispute runs through its own use case, with its
key (`commission-payouts.dispute.attribute`) and the step-up. Both routes need
`commission-payouts.dispute.view` and are admin only. Stripe's dispute id is never answered or
written here (only the case page carries it, for the Dashboard link).

## List: `GET /commission-payouts/admin/disputes`

- **Views:** `view` all (default) or one bucket (needs-response, decision-needed, under-review,
  won, closed); the older panel's `filter` names one bucket and is never sent with `view`.
  `counts` gives every view for the Market, whatever the filter, in one grouped statement.
- **Search:** `q` is a dispute id or an order id (exact); `search` is a part of the store name (2 to
  80 characters) through the sellers facade (`searchStoreNames`). A failed lookup refuses the
  request (`commission-payouts.search-unavailable`, 503) instead of listing every case; a capped
  search sets `searchCapped`. The term is never logged.
- **Filters:** `status` (Stripe's), `money` (withdrawn, inquiry, reinstated, none: the domain's
  `moneyStateOf` as stored flags), `sellerId`, `from`/`to` on the opening, `dueBefore` (evidence
  deadline; a case without one never matches), `minAmount`/`maxAmount` (minor units).
- **Sellers:** a case names its sellers from this module's ledger rows of its order. The seller
  filter and the store search become the Market's disputed orders that have a seller order of
  those sellers (bounded by the dispute cases, not by the Market's orders). The reader walks the
  disputed orders 1,000 ids per query, so no query carries more bind parameters than that, and a
  match of more than 5,000 disputed orders is refused as `too-broad` on `search` (or on
  `sellerId` without a search), on the list and on the export.
- **Sort:** opened (default, newest first), amount, evidence-due (a case without a deadline last
  either way), updated; the dispute id breaks ties.
- **Paging:** page numbers with a total (default 25, `pageSize` 1 to 100, up to row 10,000) or
  Previous/Next with `cursor` and `limit` (default 50), newest opened first only. The older panel
  sends `filter`, `limit` and `cursor` and reads the same rows and `nextCursor` as before.
- **Rows:** as before plus `updatedAt` and `actions`: `open`, and `decide` on a decision-needed
  case when the caller holds the attribute key (asked once per page through a probe).

## Export: `GET /commission-payouts/admin/disputes/export`

- `format` csv (default) or xlsx; base columns Dispute ID, Order ID, Sellers (store names, or
  `Seller <id>`), Stage (the panel's bucket words), Amount (decimal of the currency), Currency,
  Opened (UTC); optional `columns` reason, stripe-status, money, evidence-due, closed, updated,
  seller-ids, in the order asked.
- `ids` (at most 200) writes those cases in the order given; an id that is not a case of the Market
  refuses the whole file as `commission-payouts.dispute-not-found`. Without `ids`, the list's
  selector and sort, at most 10,000 rows (`batch.too-large` with the total above that). A capped
  store search is refused (`search` `too-broad`).

## Data

No migration. The default order and the bucket views read through
`dispute_cases_bucket_idx (market_id, bucket, opened_at DESC, dispute_id DESC)`; the other sorts
sort the Market's cases, which are few. The seller filter reads `ledger_entries` through its
`(market_id, seller_id, ...)` index, narrowed to the disputed orders.

Follow-up: the admin BFF drops a malformed export value instead of refusing it (the strict check
#943 adds for the payments export is to be made common to every export relay).
