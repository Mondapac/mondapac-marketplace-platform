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
- **Row actions:** `view-order`, and `copy-stripe-reference` once Stripe made the refund.
