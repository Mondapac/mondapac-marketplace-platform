# Delivery settings and method availability

Owner: the shipping module. Delivery methods, the same-day cut-off, the scheduled window and the delivery margin are all rules about how goods move, and shipping already owns the fleet router and pickup availability. Ordering only asks (through the `DeliveryMethodPolicy` seam, which now calls the shipping facade) and fails closed if shipping cannot answer.

## What an admin controls

- Per Market (`delivery_settings`): which of pickup / instant / same_day / scheduled are on, the same-day cut-off (local time, default 12:00), scheduled days ahead (default 7, 1 to 30) and window length (default 2 hours, 30 to 480 minutes in 15-minute steps), the delivery margin and the rounding step. Saves are audited and use an expected version (409 on conflict).
- Per seller (`seller_delivery_methods`): the methods a seller does not support. Admin only, audited. Default for every existing and new seller: no restrictions, so every method the platform has on is available.

## Availability

Available = platform on, minus seller-unsupported, minus structural rules. Reasons when a method is not available: `platform-off`, `seller-unsupported`, `no-pickup-address` (pickup), `past-cut-off` (same_day). The cut-off is a wall-clock compare in the seller's fulfilment zone (the Market zone as fallback) using the injected Clock. Scheduled windows are checked on the local calendar (`window-in-past`, `window-too-far`, `window-length`, `window-missing`).

## Margin

`applyDeliveryMargin(quote, { margin, roundingStepMinor })` is pure. The buyer pays quote + margin, rounded UP to the step (1, 5, 10, 50, 100 minor units; 1 means none). Percent margins are half-up on the quote. Checkout quotes are not wired to it yet (package 5).

Migration: `20261025150000_shipping_delivery_settings` (with `down.sql`).
