-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable. Orders confirmed before this migration become 'to-ship' (they were charged no
-- delivery fee but can be shipped from the panel); the default is dropped after the backfill.
ALTER TABLE "ordering"."seller_orders"
    ADD COLUMN "fulfilment" TEXT NOT NULL DEFAULT 'to-ship',
    ADD COLUMN "carrier" TEXT,
    ADD COLUMN "tracking_ref" TEXT,
    ADD COLUMN "shipped_at" TIMESTAMPTZ(6),
    ADD COLUMN "delivered_at" TIMESTAMPTZ(6),
    ADD COLUMN "inventory_recorded_at" TIMESTAMPTZ(6);
ALTER TABLE "ordering"."seller_orders" ALTER COLUMN "fulfilment" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "seller_orders_market_id_seller_id_order_id_idx" ON "ordering"."seller_orders"("market_id", "seller_id", "order_id");

-- Hand-written: the forward-only states and their fields go together.
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_fulfilment_check" CHECK ("fulfilment" IN ('to-ship', 'shipped', 'delivered')),
  ADD CONSTRAINT "seller_orders_carrier_check" CHECK ("carrier" IS NULL OR char_length("carrier") BETWEEN 1 AND 60),
  ADD CONSTRAINT "seller_orders_tracking_ref_check" CHECK ("tracking_ref" IS NULL OR char_length("tracking_ref") BETWEEN 1 AND 80),
  ADD CONSTRAINT "seller_orders_fulfilment_fields_check" CHECK (
    ("fulfilment" = 'to-ship' AND "carrier" IS NULL AND "tracking_ref" IS NULL
      AND "shipped_at" IS NULL AND "delivered_at" IS NULL AND "inventory_recorded_at" IS NULL)
    OR ("fulfilment" = 'shipped' AND "carrier" IS NOT NULL AND "shipped_at" IS NOT NULL
      AND "delivered_at" IS NULL)
    OR ("fulfilment" = 'delivered' AND "carrier" IS NOT NULL AND "shipped_at" IS NOT NULL
      AND "delivered_at" IS NOT NULL AND "delivered_at" >= "shipped_at"));

-- Hand-written: the worker's queue of shipments inventory has not recorded yet. Invisible to Prisma.
CREATE INDEX "seller_orders_unrecorded_shipments_idx" ON "ordering"."seller_orders" ("market_id", "shipped_at")
  WHERE "inventory_recorded_at" IS NULL AND "fulfilment" <> 'to-ship';

-- Grants. The shipment and delivery fields change once each; the amounts and ids never.
GRANT UPDATE ("fulfilment", "carrier", "tracking_ref", "shipped_at", "delivered_at", "inventory_recorded_at") ON TABLE "ordering"."seller_orders" TO "mondapac_app";
