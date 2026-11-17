# As built: admin Shipments list (Sales > Shipments, 2026-11-15)

`GET /ordering/admin/shipments` behind `ordering.order.view` (the carrier, tracking and fleet
already show on the admin order page). One row per seller order of a paid order. A super list
(CLAUDE.md rule 14); saved filters and CSV/XLSX export follow on the shared super list kit.

- **Source:** `ordering.seller_orders` only. `paid_at` (the order's confirmation time) is copied
  onto each seller order by the unit that confirms the order (`PrismaOrderRepository.save`, and
  `insert` for an order stored already confirmed), and backfilled by migration
  `20261115230000_ordering_seller_orders_paid_at`. The list filters and sorts on it over the
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
- **Carrier progress (2026-11-16):** after the read unit closes, beside the store and customer
  names, ONE call per page to shipping's `carrierProgressOf` with the page's distinct seller order
  ids (port `CarrierProgressReader`, adapter `FacadeCarrierProgressReader`, logged through
  `settled()` as lookup `carrier-progress` with no ids). Row field `carrierProgress`:
  `{ progress, carrierStatus, updatedAt, proofOfDelivery, fleet } | null`, where `fleet` is the
  fleet that holds the booking (it may differ from the row's quoted `fleet`), `carrierStatus` is
  the carrier's raw code of a safe shape only (else null), and `updatedAt` is when the platform
  recorded the last change ("Carrier update received"), not the carrier's event time. It is never
  the carrier reference or the tracking link, and never touches `carrier` (the carrier the seller
  named). Page flag `carrierProgressAvailable`: false when the admin lacks
  `shipping.carrier-delivery.view` (shipping answers `access.denied`) or the lookup failed; then
  every `carrierProgress` is null and the column shows "Not available". With the flag true, null
  means no carrier booking (a pickup, a seller-shipped order, not booked yet) and shows "—". The
  lookup never fails the list. Only ids the page asked about are shown. The export columns follow
  separately.
- **Not here:** filtering or sorting by carrier progress (it would need a mirror column on
  `seller_orders`, never a join into `shipping`), and any admin action on a shipment (row actions
  are `view-order` and `copy-tracking-reference`).
- **Export (2026-11-16):** `GET ordering/admin/shipments/export`, the same rule, with the list's
  own filter keys (no paging or sort keys), `format` (`csv` default, `xlsx`), `columns` (the
  column picker's keys in the order shown; the fixed ones are always first; absent = every
  column), `ids` (the selected rows: seller order ids; at most 200, `batch.too-large` past it) and `zone`
  (IANA; default the Market's zone). At most 10,000 rows, else 413 `batch.too-large` with
  `details.total`. It reads through the list flow a page of 100 at a time (shared code:
  `application/sales-list-export.ts`, columns in `sales-list-export-columns.ts`), so customer name
  and email are filled only with `identity.customer-account.view`. Money is two columns (plain
  decimal in major units, then the currency); times are ISO 8601 with the zone's offset; codes
  are the API's codes. A name `search` is resolved once per file, and one that matched too many
  parties is refused (`search` `too-broad`) rather than giving a short file; the tab counts are not
  read on the streamed pages; a failed customer lookup fails the file (a store name stays advisory:
  the Seller ID is there). File: `shipments-<day>.csv|xlsx`.
