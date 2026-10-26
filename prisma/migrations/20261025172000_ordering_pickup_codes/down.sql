-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261025130000_ordering_pickup_codes: the pickup codes go with their grant and CHECKs,
-- and a delivered seller order must name its carrier again. A pickup order already handed over
-- keeps the carrier name 'pickup' so the restored rule holds; every pickup code is lost.
DROP TABLE "ordering"."pickup_codes";

UPDATE "ordering"."seller_orders" SET "carrier" = 'pickup'
  WHERE "fulfilment" = 'delivered' AND "carrier" IS NULL;

ALTER TABLE "ordering"."seller_orders" DROP CONSTRAINT "seller_orders_fulfilment_fields_check";
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_fulfilment_fields_check" CHECK (
    ("fulfilment" = 'to-ship' AND "carrier" IS NULL AND "tracking_ref" IS NULL
      AND "shipped_at" IS NULL AND "delivered_at" IS NULL AND "inventory_recorded_at" IS NULL)
    OR ("fulfilment" = 'shipped' AND "carrier" IS NOT NULL AND "shipped_at" IS NOT NULL
      AND "delivered_at" IS NULL)
    OR ("fulfilment" = 'delivered' AND "carrier" IS NOT NULL AND "shipped_at" IS NOT NULL
      AND "delivered_at" IS NOT NULL AND "delivered_at" >= "shipped_at"));
