# As built: the admin Account deletion requests list (list 25, 2026-11-16)

The Market's buyer account deletion requests (customers package 5, with the admin requests of 5c)
as a super list (super list plan phase 4): views with counts, filters, sort, page numbers or
Previous/Next, a row action and an export. Read only: cancelling runs through
`customers.admin-cancel-account-deletion`, which checks `customers.buyer-account.delete`, the
step-up and the status again. Both routes need `customers.account-deletion-requests.view`, are
admin only and are refused to a seller, a buyer and an acting-as session.

## List: `GET /customers/admin/deletion-requests`

- **Views:** `view` pending (default, as the older list), executing, cancelled, completed or all.
  `counts` gives every view for the Market, whatever the filter, from one grouped statement on
  the status.
- **Older list:** the panel's page keeps sending `cursor` and `limit` (20 rows by default) and
  reads the same rows, `requestId` and `nextCursor`. `status=pending` is still taken; any other
  `status`, or `status` with `view`, is refused.
- **Filters:** `requestedBy` (customer or admin), `cancelReason` (customer, sign-in, admin), `q`
  (a request id or a buyer account id, exact; never echoed or logged), `from`/`to` on the request
  time (`to` excluded), `scheduledBefore` on the deletion date.
- **Sort:** scheduled (default, earliest first), requested, cancelled, completed (newest first by
  default); a request not cancelled or not completed sorts last either way; the id breaks ties.
- **Paging:** page numbers with a total (default 25, `pageSize` 1 to 100, up to row 10,000) or
  Previous/Next with `cursor` and `limit`, earliest deletion first only (`page`, `pageSize`, `sort`
  and `direction` are refused with it). A total of a filter that is only a view comes from the
  counts.
- **Rows:** as before plus `cancelledAt`, `cancelReason`, `completedAt` and `actions`: `cancel` on
  a pending request when the caller holds `customers.buyer-account.delete` (asked once per page
  through `customers.buyer-delete-probe`).
- **No personal data:** the reader selects ids, status, who asked and times only. The ticket
  reference, the admin's reason, the buyer's name and email are never read, returned or exported.

## Export: `GET /customers/admin/deletion-requests/export`

`format` csv (default) or xlsx; `columns` adds cancelled, cancel-reason, completed; `ids` (at most
200, no repeats; one id of another Market refuses the file as not found) or the list's view,
filters and sort. At most 10,000 rows, otherwise 413 `batch.too-large` with `max` and `total`. Ids
are fixed in one read, rows stream in chunks of 500. File `deletion-requests-<day>.csv|xlsx`, the
day from the injected clock; times are UTC instants. Only the keys above are taken; any other key
is refused.

## Indexes

The pending view in scheduled order uses `account_deletion_requests_market_id_scheduled_for_pending_idx`.
The counts and the other views and sorts read the Market's rows without an index. Closed requests
are kept, so the table only grows. Trigger: when a Market holds more than 50,000 requests, or a
list read takes more than 200 ms at p95, add an index on (market_id, status, scheduled_for, id) in
a later migration (database-designer); it serves the counts and every view in the default order.

## Changes for an older caller

A call with neither `cursor` nor `limit` now gets page numbers (25 rows, a total, no
`nextCursor`). A `status` other than `pending` answers the field code `value` (was `format`). The
panel sends `cursor` and `limit` only, so it is not affected.
