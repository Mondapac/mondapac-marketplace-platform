# Notifications: order emails (Phase 6 package 1)

Two of the four simple emails of owner decision Q10 (2026-10-08). The other two (shipped, refund)
come with their own packages.

- **Trigger:** `ordering.order-paid.v1`, written to the ordering outbox in the same unit that
  confirms the order. Payload: ids only (`orderId`, `sellerOrderIds`, `sellerIds`); the Market is
  the envelope's. No email, name, address or amount is in the event or in any log line.
- **Customer, "Order confirmation"** (`notifications.order-confirmation-mail`): subject and label
  are exactly "Order confirmation", never "Tax invoice". Body: order reference, lines (product
  name, quantity), and a link `<notifications.customerOrderPage>/<order id>` from the Market
  config. The page needs sign-in; the URL holds the order id only. A Market without
  `customerOrderPage` sends no customer mail (the delivery is marked as skipped).
- **Seller, "New order"** (`notifications.seller-new-order-mail`): one mail per seller order to the
  seller's Owner: reference (the seller order id), that seller's own lines. No customer data and no
  link. The order does not store a recipient name or address yet, so none is sent.
- **Reading at send time:** the order from `ordering.orderNotice`, product names from
  `catalog.offerNames`, the address from `identity.contactEmailOf` (active, verified accounts only;
  otherwise nothing is sent). All three are `system` use cases of the facades.
- **Text only:** `MAIL_TRANSPORT` sends plain text (no HTML ever, HF13), so seller-entered product
  names cannot become markup; they are flattened to one line without control characters and cut at
  120 characters. If HTML mail is added later, escape every name in the template.
- **Failure:** the mail is sent after the payment committed, from the outbox delivery. A send
  failure throws inside the subscriber, so the dispatcher retries; it never reaches
  confirm-payment. Idempotency is the inbox row per (event, subscriber). Mail is at least once: a
  retry after one seller's send failed may repeat the mail to a seller that already got it.
- **Sender:** the Market's `identity.mail` sender. Language: English for now.
- **Data:** new tables `ordering.outbox` and `notifications.inbox` (migration
  `20261015190000_ordering_order_paid_outbox`).
