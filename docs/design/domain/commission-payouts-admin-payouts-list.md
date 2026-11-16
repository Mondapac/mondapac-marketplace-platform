# As built: admin Payouts super list (list 21, 2026-11-15)

`GET /commission-payouts/admin/payouts` behind `commission-payouts.payout.view`, now a super list
(CLAUDE.md rule 14; super list plan phase 4). One row per payout in `commission_payouts.payouts`.
Read only: approving, placing and releasing a hold stay on their own routes, keys and step-up.
The older panel's query (`status`, `cursor`, `limit`) keeps working unchanged.

- **Views (tabs):** `all`, `awaiting-approval`, `sending` (approved, instructing, instructed),
  `paid`, `failed`, `not-sent`; `counts` comes from one group-by on the state, whatever the filter.
  `status` narrows a view to one state (both are kept: a state outside the view matches nothing).
- **Search:** `q` is an exact payout id; `search` (2 to 80 characters) is a store name, resolved
  by sellers' `searchStoreNames` before the read and failing closed
  (`commission-payouts.search-unavailable`, 503). Neither is logged.
- **Filters:** seller, approval mode, creation time (`from` included, `to` excluded), transfer
  amount in minor units (both ends included).
- **Sort:** created (default, newest first), amount (transfer), state-changed, slot; the id breaks
  ties. No new index: the table holds thousands of rows; the default order and the cursor use
  `payouts_market_id_created_at_id_idx`.
- **Paging (List paging):** page numbers with a total (`page`, `pageSize` 1 to 100, default 25, up
  to row 10,000, else `too-deep`); or Previous/Next with `cursor` and `limit` (default 50), newest
  first only. A view-only filter takes its total from the counts; a narrower one is counted.
- **Row actions** (`actions`, from the caller's keys through probe use cases, and the state):
  `open`; `approve` on `awaiting-approval` (`payout.approve`); `place-hold` on pending,
  awaiting-approval or approved when the seller has no active admin hold (`payout-hold.place`);
  `release-hold` when the seller has an active admin hold over the whole seller
  (`payout-hold.release`; the row's `activeHoldId` names the newest). System holds and holds on
  one seller order are not offered here. All three are level 3 in the panel (type-to-confirm and
  step-up); each use case checks its key, the state and the step-up again.
- **Export** `GET /commission-payouts/admin/payouts/export`: the only bulk action (no bulk money
  action exists). CSV or XLSX through the shared writer; `ids` (at most 200, all the Market's or
  `payout-not-found`) or the list's selector, at most 10,000 (`batch.too-large`, 413, with the
  total). Amounts are decimals of the currency (AUD `123.45`, JPY `12345`).
- **Saved filters:** the list key `admin.commission-payouts.payouts` is registered once the generic
  saved-filter registry (B0-1b, #918) is on main.
