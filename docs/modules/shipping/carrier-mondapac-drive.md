# Shipping: the real-time carrier, Mondapac Drive (SHP-02/03)

The `real_time_delivery` FulfillmentStrategy. A paid seller order whose pickup (the seller's
operating address) and drop-off (the customer's delivery address) both fall in a ServiceArea the
Market's carrier serves is booked with Mondapac Drive (repository `Mondapac/mondapac-drive`).

**Delivery models, package 1 (owner decision).** The seller never delivers and never chooses the
method or the provider: it only tells the platform an order is ready. The buyer chooses a method per
seller order (`pickup`, `instant`, `same_day`, `scheduled`; stored on `ordering.seller_orders`, with the
scheduled window as UTC instants; orders from before the column are backfilled `instant`). Booking
time: `scheduled` is booked at payment for the buyer's window (`ordering.order-paid.v1`);
`instant` and `same_day` are booked when the seller marks ready (`ordering.seller-order-ready.v1`,
subscriber `ordering.book-ready-carrier-delivery`); `pickup` never books a carrier. When no carrier
can serve (`no-carrier`) or Drive refuses, shipping answers `no-carrier` or `refused` and ordering
sets `delivery_attention = 'no-carrier'` on the seller order (a "needs platform attention" state
for an admin); there is no `seller_managed` fallback any more. `ordering` asks the
`DeliveryMethodPolicy` port which methods a seller order may use (all four today; the platform and
per-seller settings plug in there). Drive receives the window as `scheduledWindow` (assumed field,
to be confirmed against Drive's API).

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

## Fleet router and selection models (delivery models, package 3)

The seller never chooses a method or a fleet. The platform picks the fleet per seller order from
the buyer's method and the fleets' state. Drive is now one fleet behind the same port as the
others (`CarrierGateway`: `fleet`, `capabilities(market)`, `book`, `quote`, `cancel`, `status`).

- **Candidates.** A fleet is a candidate when `capabilities(market)` is not null (OFF) and it
  serves the method, the temperature, the item count, weight and declared value, no prohibited
  class, and the stops: both ends in its `serviceAreas`, or, for `outsideCityAreasOnly`, a
  drop-off in no service area.
- **Ranking.** The admin picks one model per Market and method (`shipping.fleet_selection_*`):
  `cheapest` (lowest quote), `weighted` (weights over price, ETA and reliability) or
  `fixed_priority` (an ordered list; fleets not on it are not used). Without an active model the
  built-in order is Drive, Uber Direct, Zoom2u, Australia Post. Quotes are asked only when the
  rule needs them and more than one candidate exists. Drive wins ties. A weighted score uses
  integer arithmetic; a fleet with no ETA scores 0 on it.
- **Reliability** is a 0 to 100 score per fleet and Market that an admin sets (default 50 when
  unset). A score computed from delivery history comes later and will replace the stored one.
- **Booking.** The first ranked fleet is booked; the next one is tried only on
  `carrier.not-configured`, `carrier.refused` or a capability mismatch. `carrier.unauthorized`
  (401/403, nothing was booked) also falls back, logged at warn: it is an ops problem.
  `carrier.unavailable` from a fleet with `idempotentBooking: false` is never retried and never
  replaced, because the order may already be booked: the seller order gets
  `delivery_attention = carrier-unknown` for an admin. For an idempotent fleet the same fleet is
  tried first on the next attempt. Nothing able to serve gives `no-carrier`.
- **Attempts.** `shipping.fleet_booking_attempts` is written before each book call and kept on
  `unavailable`, so a retry goes to the same fleet, or answers `unknown` with no call for a
  non-idempotent one. It is cleared on a booking, a refusal, not-configured and unauthorized.
- **Cancel.** The booking row holds the fleet (`carrier_bookings.fleet`). For a non-idempotent
  fleet a cancel answered `carrier.refused` may be a lost first answer, so it is not read as
  "still booked": the order gets `delivery_attention = cancel-unknown`.
- **Webhooks and status.** Each adapter has a pure `toFleetStatus(raw)` onto `pending`,
  `assigned`, `picked_up`, `delivered`, `cancelled`, `returned`, `failed`. The Drive webhook maps
  its status through it and then onto the booking progress; its signature check is unchanged. A
  Drive event for a booking of another fleet is refused.
- **Admin.** `GET/POST/PUT shipping/admin/fleet-selection[...]` (permissions
  `shipping.fleet-selection.view` and the protected `.manage`); every create, edit, activation
  and reliability change is audited.
- **Assumed Drive fields** (not in Drive's contract yet; read when present, ignored otherwise):
  `GET /delivery/deliveries/:id` for `status()`, and `etaMinutes`, `expiresAt` and `trackingUrl`
  in answers. The Drive quote request is unchanged (postcode only).
- **Not here:** admin cut-off, window, margin and enabled-methods settings (package 4) and the
  checkout quote wiring (package 5). `shippingFees` still quotes Drive only.
