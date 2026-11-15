# As built: admin Shipments list (Sales > Shipments, 2026-11-15)

`GET /ordering/admin/shipments` behind `ordering.order.view` (the carrier, tracking and fleet
already show on the admin order page). One row per seller order of a paid order. A super list
(CLAUDE.md rule 14); saved filters and CSV/XLSX export follow on the shared super list kit.

- **Source:** `ordering.seller_orders` only. `paid_at` (the order's confirmation time) is copied
  onto each seller order by the unit that confirms the order (`PrismaOrderRepository.save`, and
  `insert` for an order stored already confirmed), and backfilled by migration
  `20261115140000_ordering_seller_orders_paid_at`. The list filters and sorts on it over the
  partial index `seller_orders_market_id_paid_at_id_idx` (paid rows only). Only a customer
  search joins `orders` (for the account id).
- **Stages (tabs):** `to-prepare` (paid, not ready), `ready`, `shipped`, `delivered`, and
  `refunded`: refunded in full before shipping, as an admin cancellation leaves it (the order
  stays `confirmed` and the seller order `to-ship`). `refunded_in_full` is kept by the refund
  unit in the same statement that raises `refunded_amount` to the total, and cleared when a
  refund fails; a CHECK holds it equal to `total_amount > 0 AND refunded_amount = total_amount`.
  The to-ship tabs read the partial index `seller_orders_market_id_to_ship_paid_at_idx`.
- **Counts:** two reads per request: a group-by of the paid rows (fulfilment, refunded in full,
  attention) and a count of ready within to-ship. A filter that is only a tab takes its total
  from the counts; only a narrower filter is counted again.
- **Paging (List paging setting):** page numbers with a total (`page`, `pageSize`, `sort`,
  `direction`; page x pageSize up to 10,000, else `too-deep`), or Previous/Next with `limit`
  and `cursor` (`<paid-at ms>.<seller order id>`, newest payment first, no total), which also
  reaches rows past 10,000. The two modes do not mix (`with-cursor`).
- **Search:** `q` is an exact seller order id, order id or tracking reference (the seller's own
  tracking rule, spaces allowed); `search` (2 to 80 characters) is resolved to customers and
  stores by their owning modules first and fails closed (`ordering.search-unavailable`).
- **Money:** `shipping` is what the buyer paid for delivery, tax included (the fee plus its tax
  where the price excluded it); `total` and `refunded` as stored.
- **Not here:** the carrier's own progress (in `shipping`, a follow-up through its facade), and
  any admin action on a shipment (row actions are `view-order` and `copy-tracking-reference`).
