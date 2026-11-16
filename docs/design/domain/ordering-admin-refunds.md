# As built: admin Refunds list (Sales > Refunds, 2026-11-15)

`GET /ordering/admin/refunds` behind `ordering.order.view` (the order page already shows refunds
under that key). One row per refund in `ordering.refunds`, with its order's customer (for the
name lookup) and its credit note. Read only: refunding stays on the order page. A super list
(CLAUDE.md rule 14); saved filters and CSV/XLSX export follow on the shared super list kit.

- **Index:** `refunds_market_id_requested_at_id_idx (market_id, requested_at DESC, id DESC)`,
  built CONCURRENTLY (migration `20261115130000_ordering_refunds_list_index`), serves the
  default order, the request-time filter and the Previous/Next keyset.
- **Tabs:** the refund states (`pending`, `succeeded`, `failed`), counted with one group-by. A
  filter that is only a state takes its total from the counts; a narrower filter is counted.
- **Filters:** state, reason, actor (admin or seller), loss bearer, ledger (`waiting`: succeeded
  and not yet in the seller ledger; `recorded`), seller, request time, gross amount, and
  `parties` from the search. The ledger filter is an AND beside the state, never a replacement.
- **Search:** `q` is an exact refund, order or seller order id, or a Stripe refund id (`re_...`);
  `search` (2 to 80 characters) goes to the owning modules first and fails closed
  (`ordering.search-unavailable`). Neither is logged.
- **Paging (List paging setting):** page numbers with a total (`page`, `pageSize`, `sort`,
  `direction`; up to 10,000 rows, else `too-deep`), or Previous/Next with `limit` and `cursor`
  (`<requested-at ms>.<refund id>`, newest request first, no total), which also reaches rows
  past 10,000.
- **Row actions:** `view-order`, and `copy-stripe-reference` once Stripe made the refund. The
  Stripe refund id (`re_...`) is shown to admins on purpose: an object id, not a credential.
- **Export (2026-11-16):** `GET ordering/admin/refunds/export`, the same rule, with the list's
  own filter keys (no paging or sort keys), `format` (`csv` default, `xlsx`), `columns` (the
  column picker's keys in the order shown; the fixed ones are always first; absent = every
  column), `ids` (the selected rows: refund ids; at most 200, `batch.too-large` past it) and `zone`
  (IANA; default the Market's zone). At most 10,000 rows, else 413 `batch.too-large` with
  `details.total`. It reads through the list flow a page of 100 at a time (shared code:
  `application/sales-list-export.ts`, columns in `sales-list-export-columns.ts`), so customer name
  and email are filled only with `identity.customer-account.view`. Money is two columns (plain
  decimal in major units, then the currency); times are ISO 8601 with the zone's offset; codes
  are the API's codes. A name `search` is resolved once per file, and one that matched too many
  parties is refused (`search` `too-broad`) rather than giving a short file; the tab counts are not
  read on the streamed pages; a failed customer lookup fails the file (a store name stays advisory:
  the Seller ID is there). File: `refunds-<day>.csv|xlsx`.
