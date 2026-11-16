# As built: the admin Seller accounts list (list 22, 2026-11-16)

The Market's seller payout (Stripe connected) accounts as a super list (super list plan phase 4):
status tabs with counts, search, filters, sort, page numbers or Previous/Next, and an export.
Read only: no action here moves money or changes an account. Both routes need
`payments.connected-account.view` and are admin only. No Stripe id, account hash, bank detail
or requirement content is ever answered or written to the file.

## List: `GET /payments/admin/connected-accounts`

- **Tabs:** `status` (not-started, pending, enabled, restricted, rejected). `counts` gives every
  status plus `all` for the same search and filters, in one grouped statement; null in
  Previous/Next.
- **Search `q`:** a seller id finds that seller exactly; any other text (2 to 100 characters)
  searches the approved public store names through the sellers facade (`searchStoreNames`). A
  failed lookup refuses the request (`payments.search-unavailable`, 503) instead of listing every
  account. The term is never logged.
- **Filters:** `ready` (yes, no: enabled and outside the waiting period, the domain's
  `isPayoutReady`), `requirements` (past-due, due, none), `waiting` (cooling-off, paused), `from`/
  `to` on the creation. Readiness and waiting are judged at the clock's now, never the caller's.
- **Sort:** created (default, newest first), last-read (never read last when newest first),
  requirements (past due first, then the count); the seller id breaks ties.
- **Paging:** the shared list query (`paging` pages or prev-next, `page`, `pageSize` 1 to 100,
  default 25, up to row 10,000). The older card's `cursor` keeps working: newest created first,
  25 rows; `nextCursor` is set whenever the rows are newest created first and more follow.
- **Rows:** as before plus the store name (`sellerName`, null when sellers cannot say) and
  `actions` (`open`).

## Export: `GET /payments/admin/connected-accounts/export`

- `format` csv (default) or xlsx; base columns Seller (store name, or `Seller <id>`), Status,
  Ready, Details due, Past due, Created; optional `columns` cooling-off, paused, last-read,
  seller-id, in the order asked. Words follow the admin panel's `payments.accounts` messages.
- `ids` (seller ids, at most 200) writes those rows in the order given; a seller without an
  account in this Market refuses the whole file as `payments.connected-account.not-found`.
  Without `ids`, the list's selector and sort, at most 10,000 rows (`batch.too-large` with the
  total above that). A capped store search is refused (`q` `too-broad`) so the file is never a
  silent part of the match.
- The admin BFF checks this route's query strictly: a known key out of shape refuses the request
  (400) instead of being dropped, so the file is never wider than the one asked for.

## Data

No migration and no new index: a Market has one row per seller that started a payout account
(`connected_accounts`, primary key `(market_id, seller_id)`), so every sort sorts a few thousand
rows at most. If the table grows past that, an index on `(market_id, created_at DESC, seller_id
DESC)` serves the default order and the cursor.
