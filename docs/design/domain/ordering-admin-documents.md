# As built: admin Invoices list (Sales > Invoices, 2026-11-15)

`GET /ordering/admin/documents?kind=` behind `ordering.order.view`. Owner decision 2026-11-15:
until numbered tax invoices exist (gap-free numbering waits for the tax adviser, AG-11), the page
lists the documents the platform already issues, one kind per tab:

- `order-confirmation` (default): one per paid seller order, read from `ordering.seller_orders`
  over `paid_at` and its partial index (see `ordering-admin-shipments.md`), with no join to
  `orders` except for a customer search.
- `credit-note`: one per succeeded refund, from `ordering.credit_notes`.

Neither is labelled a tax invoice, and `documentNumber` is always null until numbering is built.
A super list (CLAUDE.md rule 14); saved filters and CSV/XLSX export follow on the shared kit.

- **Money:** `total` is tax included. A confirmation's `tax` follows the order page's rules
  (`linesTax` plus `shippingTaxOf`): null only when a line was placed before its tax was
  recorded; a delivery fee with no recorded tax counts as none. `shipping` is tax included on
  both kinds (the fee plus its tax where the price excluded it, or the shipping given back).
- **Counts and total:** two counts per request (confirmations, credit notes); a filter that is
  only a tab takes its total from them, a narrower filter is counted.
- **Paging (List paging setting):** page numbers with a total (`page`, `pageSize`, `sort`,
  `direction`; up to 10,000 rows, else `too-deep`), or Previous/Next with `limit` and `cursor`
  (`<issued-at ms>.<document id>`, newest first, no total), which also reaches rows past 10,000.
- **Search:** `q` is an exact order, seller order, credit note or refund id; `search` (2 to 80
  characters) goes to the owning modules first and fails closed.
- **Row actions:** `view-order` on both; `download-order-document` on confirmations (the order
  document admins already get on the order page). A credit note has no document of its own yet.
- **Follow-up:** an index `(market_id, issued_at DESC, id DESC)` on credit notes when they grow.
