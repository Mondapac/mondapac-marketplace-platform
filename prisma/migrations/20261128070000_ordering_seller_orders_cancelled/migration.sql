-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- BUG-017 (operational test G-43): an admin's Cancel and refund gave the money back but left the
-- order looking paid and its stock held. The order's stored status stays `confirmed` (ordering
-- design 3.2: after payment the display status is derived from the seller orders), so the
-- cancellation is recorded on each seller order: `cancelled_at`, written by the cancellation's unit
-- under the row lock the refunds already hold, only while the seller order is to-ship and not
-- ready. It is final (it can no longer be marked ready). `stock_released_at` is written by the
-- worker once inventory has cancelled the committed lines, so the units are sellable again.
-- Adding nullable columns is a catalogue change only. The CHECKs are added NOT VALID (no scan
-- under the ACCESS EXCLUSIVE lock) and validated next, under a lock that lets writes through.
ALTER TABLE "ordering"."seller_orders"
  ADD COLUMN "cancelled_at" TIMESTAMPTZ(6),
  ADD COLUMN "stock_released_at" TIMESTAMPTZ(6);

ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_cancelled_check" CHECK (
    "cancelled_at" IS NULL OR ("fulfilment" = 'to-ship' AND "ready_at" IS NULL)) NOT VALID,
  ADD CONSTRAINT "seller_orders_stock_released_check" CHECK (
    "stock_released_at" IS NULL OR "cancelled_at" IS NOT NULL) NOT VALID;
ALTER TABLE "ordering"."seller_orders" VALIDATE CONSTRAINT "seller_orders_cancelled_check";
ALTER TABLE "ordering"."seller_orders" VALIDATE CONSTRAINT "seller_orders_stock_released_check";

-- Grants. Each is written once, by the API (cancellation) and the worker (release).
GRANT UPDATE ("cancelled_at", "stock_released_at") ON TABLE "ordering"."seller_orders" TO "mondapac_app";
