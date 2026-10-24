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
4. `shipping.cancelCarrierDelivery` cancels a booking not yet picked up. It is not wired to an
   order event yet, because a paid order cannot be cancelled today (only refunded).

| Drive status | Progress | Seller order |
|---|---|---|
| SCHEDULED, DISPATCHING, ASSIGNED, AT_PICKUP | booked | to ship |
| PICKED_UP, AT_DROPOFF | picked-up | shipped |
| DELIVERED | delivered | delivered |
| DELIVERY_FAILED, RETURNING, RETURNED | exception | unchanged (an admin follows up) |
| CANCELLED | cancelled | unchanged |

An unknown status is recorded as taken and changes nothing. A final state is never left, and a
cancellation after pickup is ignored.

## Drive API calls

- `POST /delivery/deliveries` with `merchantId`, `externalReference`, `pickup` and `dropoff`
  (`address` as one line, `postcode`, `contactName`, `contactPhone`, optional `notes`), and
  `parcel` and `mode` from the Market config. No `point`: the marketplace stores no coordinates,
  so Drive geocodes the address.
- `POST /delivery/deliveries/:id/events` with `{ "type": "cancelled" }`.
- Headers: `Authorization: Bearer <MONDAPAC_DRIVE_API_KEY of the Market>` and `x-market-id`.
- Client: a timeout per attempt (the whole call at most 6 s); retries with backoff (`backoffMs * 2^(n-1)`) on a 5xx, a timeout
  or a network fault, never on a 4xx; redirects refused; a circuit breaker per Market and endpoint.
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
- Before the secrets are set for a production Market:
  - wire `cancelCarrierDelivery` to the refund path. Until then, a refund before pickup does not
    stop the delivery; the progress is logged at warn as
    `ordering.carrier-progress-on-unconfirmed-order` for an admin;
  - replace the placeholder `baseUrl` and `merchantId` in `config/markets/AU.json`.
- Follow-ups: cap the size of Drive's answer body; key the circuit breaker per call as well as per
  endpoint; a retention job for `shipping.carrier_events`.
