# As built: the seller's Earnings › Payouts list (list 33, 2026-11-16)

The seller panel's payout history as a super list (super list plan phase 4): status tabs with
counts, search by payout id, filters, sort, paging and export. Read only; the seller is always
the session's (rule `own-resources`, allowed while the seller is not approved, as the older
route was). Another seller's payout, another Market's and a voided payout never show.

## List: `GET /commission-payouts/seller/payouts`

- **Statuses** are the seller's words over the payout states (the panel's `SELLER_STATUS`):
  scheduled (pending, approved), awaiting-approval, on-its-way (instructing, instructed), paid,
  not-sent, failed, settled (settled-by-netting). `counts` gives every status plus `all`, for the
  seller's own shown payouts, whatever the filter.
- **Filters:** `status`, `q` (a payout id, exact), `from`/`to` on the creation, `minAmount`/
  `maxAmount` (minor units of the transfer).
- **Sort:** created (default, newest first), amount (the transfer), slot; the id breaks ties.
- **Paging:** page numbers with a total (default 25 to a page) or Previous/Next with `cursor` and
  `limit` (default 50), newest first only. The older Earnings card sends `limit` and `cursor` and
  reads the same answer as before; every row now also carries `actions` (`open`).
- An unknown key, or a value out of shape, refuses the whole query with every field at once,
  before anything is read.

## Export: `GET /commission-payouts/seller/payouts/export`

- Needs `commission-payouts.earnings.view` (as the seller's ledger does): a bulk file of money
  rows is not for every team member. The list itself keeps the older route's rule
  (`own-resources`); whether the list, `payouts/next` and `payout-holds` should also need the key
  is open for cto (review of #935).

- `format` csv (default) or xlsx; base columns Payout ID, Status (the panel's words), Amount,
  Currency, Created; optional `columns` gross, netted, slot, updated, in the order asked.
- `ids` (at most 200) writes those rows in the order given; an id that is not one of the
  seller's shown payouts refuses the whole file as `commission-payouts.payout-not-found`.
  Without `ids`, the list's selector and sort, at most 10,000 rows (`batch.too-large` with the
  total above that). Amounts are decimals of the currency; every cell is a string.

The reader is the admin Payouts list's (`AdminPayoutListReader`); `countByState` takes an
optional seller id. No new index: one seller's payouts read through the existing
`payouts (market_id, seller_id, created_at DESC, id DESC)` order.

Open follow-ups (review of #935): the BFF drops an export value out of shape instead of refusing
it (the same in every export relay; to fix once for all); the export's base date column is the
creation, while the older card shows the slot ("Date"): to settle with the designer and the
frontend before the list's frontend.
