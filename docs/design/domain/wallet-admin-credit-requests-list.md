# As built: the admin Credit requests list (list 24, 2026-11-16)

The Market's admin credit issues and requests (customer wallet package 2a, maker-checker) as a
super list (super list plan phase 4): views with counts, filters, sort, page numbers or
Previous/Next, row actions and an export. Read only: approving and rejecting run through their own
use cases, which check `wallet.credit.approve`, the step-up, the four-eyes rule and the expiry
again. No bulk money action exists; the only bulk action is the export. Both routes need
`wallet.credit.view`, are admin only and are refused in an acting-as session.

## List: `GET /wallet/admin/credit-requests`

- **Views:** `view` pending (default), decided (approved, rejected, expired), granted (granted at
  once, under the caps) or all. `counts` gives every view for the Market, whatever the filter, from
  one grouped statement on the status.
- **Older queue:** without `view`, a `status` of pending, decided or granted is read as the view, so
  the panel's request queue keeps sending `status`, `cursor` and `limit` and reads the same rows
  and `nextCursor` (20 rows by default).
- **Filters:** `status` (one status inside the view; outside it nothing matches), `reason`,
  `approvalReason`, `q` (a request id or a customer account id, exact), `requestedBy` (an admin
  account id, or `me`), `from`/`to` on the request time, `minAmount`/`maxAmount` (minor units, both
  ends included).
- **Sort:** requested (default, newest first), amount, expires, decided; a request without an
  expiry (granted at once) or not decided yet sorts last either way; the request id breaks ties.
- **Paging:** page numbers with a total (default 25, `pageSize` 1 to 100, up to row 10,000) or
  Previous/Next with `cursor` and `limit`, newest first only. A total of a filter that is only a
  view (and one status) comes from the counts, without a second count.
- **Rows:** as before plus `actions`: `open`, and `approve` and `reject` on a pending request that
  another admin asked for and that has not expired, when the caller holds `wallet.credit.approve`
  (asked once per page through `wallet.credit-approve-probe`). The maker never sees them on their
  own request.

## Export: `GET /wallet/admin/credit-requests/export`

- `format` csv (default) or xlsx; base columns Request ID, Customer ID, Amount (decimal of the
  currency), Currency, Reason, Status (the panel's words), Requested by, Requested (UTC); optional
  `columns` note, approval-reason, expires, decided-by, decided, decision-reason, journal, in the
  order asked.
- `ids` (at most 200) writes those requests in the order given; an id that is not a request of the
  Market refuses the whole file as `wallet.credit-request-not-found`. Without `ids`, the list's
  selector and sort, at most 10,000 rows (`batch.too-large`, 413, with the total above that).
- CSV: a text cell that starts with `= + - @` gets a leading quote; XLSX: every cell is a string.
  The admin's note is written only when the `note` column is asked for.

## Data

No migration. The views read through
`(market_id, status, requested_at DESC, id DESC)`; the all view and the other sorts sort the
Market's requests, which are few (only issues above the caps wait, and they expire). The old
repository `list` method is replaced by the list reader (`ADMIN_CREDIT_LIST_READER`).
