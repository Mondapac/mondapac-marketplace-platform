# Shipping: the real-time carrier, Mondapac Drive (SHP-02/03)

The `real_time_delivery` FulfillmentStrategy. A paid seller order whose pickup (the seller's
operating address) and drop-off (the customer's delivery address) both fall in a ServiceArea the
Market's carrier serves is booked with Mondapac Drive (repository `Mondapac/mondapac-drive`). Every
other seller order stays `seller_managed` (SHP-01): the seller ships and types in the carrier.

## Flow

1. `ordering.order-paid.v1` -> ordering's subscriber `ordering.book-carrier-deliveries` opens the
   sealed delivery address and calls `shipping.bookCarrierDelivery` per seller order still to ship.
   Ordering imports shipping, never the reverse (no circular dependency).
2. Shipping checks the strategy, reads the pickup from sellers' `carrierPickup` (system rule, one
   audit row `sellers.pickup-details.read-for-carrier` per read), calls Drive outside any unit, and
   stores `shipping.carrier_bookings` plus `shipping.carrier-delivery-progressed.v1` in one unit.
   Drive books once per merchant and `externalReference` (the seller order id), so a retry after a
   lost answer gets the first delivery back.
3. Drive's signed webhooks move the booking forward only. Each change of progress publishes
   `shipping.carrier-delivery-progressed.v1` (ids only). Ordering's subscriber
   `ordering.record-carrier-progress` reads the current state and records picked up as shipped
   (carrier name and Drive's delivery id as the tracking reference, with `ordering.order-shipped.v1`)
   and delivered as delivered.
4. `shipping.cancelCarrierDelivery` cancels a booking not yet picked up. A paid order cannot be
   cancelled (only refunded), so the trigger is a refund: when Stripe confirms one, ordering
   writes `ordering.refund-succeeded.v1` (ids only) and its subscriber
   `ordering.cancel-carrier-after-refund` cancels the delivery once every unit of the seller order
   is refunded. A partial refund leaves the delivery. If the carrier has already picked it up,
   `ordering.carrier-delivery-not-cancelled-after-refund` is logged at warn for an admin.

| Drive status                                | Progress  | Seller order                    |
| ------------------------------------------- | --------- | ------------------------------- |
| SCHEDULED, DISPATCHING, ASSIGNED, AT_PICKUP | booked    | to ship                         |
| PICKED_UP, AT_DROPOFF                       | picked-up | shipped                         |
| DELIVERED                                   | delivered | delivered                       |
| DELIVERY_FAILED, RETURNING, RETURNED        | exception | unchanged (an admin follows up) |
| CANCELLED                                   | cancelled | unchanged                       |

An unknown status is recorded as taken and changes nothing. A final state is never left, and a
cancellation after pickup is ignored.

## The fee at checkout (live quote)

Owner decision 2026-10-24: the customer pays the carrier's live price where Drive will carry the
seller order, and the seller's flat fee everywhere else.

- `ordering.start-checkout` calls `shipping.shippingFees(sellerIds, { postcode, locality })` in
  place of the flat fees. The cart still shows the flat fees (`shipping.flatFees`).
- `shipping.shipping-fees` (rule `own-resources`) reads the flat fees, then quotes each seller
  whose approved pickup postcode and the drop-off both fall in a ServiceArea the Market's carrier
  serves (at most 10 quotes per checkout; the rest keep the flat fee).
- The pickup postcode is `sellers.business_file_revisions.operating_postcode`, a clear column
  copied at submission like `service_area_code` (sellers' `pickupPostcodes`, rule `anonymous`,
  no decryption and no audit row). A revision written before the column has none: that seller
  keeps the flat fee until its next approved revision.
- A quote sends the two postcodes only, never a street, a suburb the customer typed, a name or a
  phone (free text would let a customer move the quoted place). The street, names and phones go
  to Drive only at booking.
- A quote that fails, is refused, times out, comes in another currency or falls outside the
  Market's `quoteBounds` falls back to the flat fee (out of bounds is logged at warn as
  `shipping.shipping-fees-quote-out-of-bounds`); a seller with neither a quote nor a flat fee is
  refused as before (`ordering.shipping-unavailable`).
- A quote is kept 5 minutes per Market, postcode pair, parcel and mode, so a checkout repeated in a
  loop asks Drive once.
- Drive's `total` includes tax, so a quoted fee is taxed as tax-inclusive, whatever the basis of
  the seller's goods.
- The quoted fee is frozen on the seller order like the flat fee. The booking does not send
  `expectedTotal`: Drive books at its price at that moment (the street address against the
  postcode), and the difference from the quote is the marketplace's.

## Drive API calls

- `POST /delivery/deliveries` with `externalReference`, `pickup` and `dropoff`
  (`address` as one line, `postcode`, `contactName`, `contactPhone`, optional `notes`), and
  `parcel` and `mode` from the Market config. No `point`: the marketplace stores no coordinates,
  so Drive geocodes the address.
- `POST /delivery/quotes` with `pickup` and `dropoff` as `{ postcode, address }` (both the
  postcode), `parcel` and `mode`. Only `total` (`{ amount, currency }`, minor units
  as decimal text) is read.
- `POST /delivery/deliveries/:id/cancel` with `{ "reason": "..." }`. A 409 (picked up already)
  is taken as not cancellable.
- No merchant field: Drive's merchant is the API key's, and its schemas reject unknown fields.
- Headers: `Authorization: Bearer <MONDAPAC_DRIVE_API_KEY of the Market>` and `x-market-id`.
- Client: a timeout per attempt (the whole call at most 6 s); retries with backoff (`backoffMs * 2^(n-1)`) on a 5xx, a 429 (not on a quote, which falls back to the flat fee at once), a timeout
  or a network fault, never on a 4xx; redirects refused; a circuit breaker per Market, endpoint and kind of call (book, cancel, quote), so failing
  quotes never stop bookings.
  Only the delivery id and status are read from an answer; the echoed stops are dropped.

## Webhook

`POST /shipping/carriers/mondapac-drive/webhook/<MARKET>`, raw body, no session or Origin. This is
the format Drive's notifications package emits (Drive `docs/notifications/webhooks.md`).

- `Drive-Timestamp`: Unix seconds. `Drive-Signature`: `v1=<hex>[,v1=<hex>]` (up to 4, one per
  secret during a rotation), each the lower-case hex HMAC-SHA256, under the Market's
  `MONDAPAC_DRIVE_WEBHOOK_SECRET`, of `<timestamp>.<raw body bytes>`.
- The request is accepted when the timestamp is within 300 seconds of now and one `v1` matches
  (constant-time comparison).
- Body: `{ id (UUID), type, occurredAt, marketId, data: { deliveryId, externalReference, status,
... } }`. The types `delivery.booked`, `delivery.status-changed` and `delivery.cancelled` are
  applied; any other type answers 200 and is dropped.
- Each event is taken once by `id` (`shipping.carrier_events`), in the same unit as the booking
  change and its outbox event.
- Answers:
  - 200: applied, duplicate, unchanged or ignored.
  - 400: bad signature, a malformed body, a `marketId` other than the path's, or a `deliveryId`
    other than the booking's.
  - 404: no booking for the reference yet (Drive retries).
  - 415: not JSON.
  - 503: no secret for the Market.

## Configuration

- `shipping.realTimeCarrier` in `config/markets/<CODE>.json` (see `config/markets/README.md`).
- The secrets `MONDAPAC_DRIVE_API_KEY` and `MONDAPAC_DRIVE_WEBHOOK_SECRET` (`.env.example`).
- Without both secrets the carrier is off for that Market (fail closed).

## Personal data

The two stops (names, phones, addresses) go to Drive only. They are never stored, logged or put
in an event or an error.

## Limits and open items (security review, Hassan, 2026-10-24)

- One carrier call (every attempt, timeout and backoff) must fit in 6 s (`MAX_CARRIER_CALL_MS`,
  checked when the Market config loads), because it runs inside an event handler with a 20 s
  budget. The booking handler starts a next seller order only while one more booking and the
  inbox unit still fit; otherwise the delivery is retried and the seller orders already booked
  answer at once.
- A refund in full before pickup cancels the delivery (step 4). Progress on an order that is no
  longer confirmed is logged at warn as `ordering.carrier-progress-on-unconfirmed-order`.
- Before the secrets are set for a production Market, replace the placeholder `baseUrl` in
  `config/markets/AU.json`.
- An answer body over 64 KiB is not read and counts as no answer.
- Follow-up: a retention job for `shipping.carrier_events`.
