-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Delivery models, package 2: the pickup code. One row per seller order the buyer collects in
-- person, written when the seller marks it ready. The code is never stored in the clear: the hash
-- is a keyed hash under the buyer's data key (what the seller's typed code is compared with), the
-- sealed copy is the code sealed under the same key so only the buyer's own view can show it.

-- CreateTable
CREATE TABLE "ordering"."pickup_codes" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "code_sealed" TEXT NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMPTZ(6),
    "issued_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pickup_codes_pkey" PRIMARY KEY ("market_id","seller_order_id")
);

-- AddForeignKey
ALTER TABLE "ordering"."pickup_codes" ADD CONSTRAINT "pickup_codes_market_id_seller_order_id_fkey" FOREIGN KEY ("market_id", "seller_order_id") REFERENCES "ordering"."seller_orders"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: scope and value checks of the new table (empty, so no NOT VALID step). Five wrong
-- codes lock the order: the count stops at five, and a lock time is only ever set at five (the
-- count and the time are written by two statements, so five without a time is a passing state).
ALTER TABLE "ordering"."pickup_codes"
  ADD CONSTRAINT "pickup_codes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "pickup_codes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "pickup_codes_code_hash_check" CHECK (char_length("code_hash") BETWEEN 1 AND 256),
  ADD CONSTRAINT "pickup_codes_code_sealed_check" CHECK (char_length("code_sealed") BETWEEN 1 AND 1024),
  ADD CONSTRAINT "pickup_codes_failed_attempts_check" CHECK (
    "failed_attempts" BETWEEN 0 AND 5
    AND ("locked_at" IS NULL OR "failed_attempts" = 5));

-- Hand-written: a seller order handed over in person is `delivered` without a carrier. Until now a
-- delivered seller order always named its carrier; a pickup order has none, so the carrier is
-- required of every delivered order except a pickup one. The other rules are unchanged.
ALTER TABLE "ordering"."seller_orders" DROP CONSTRAINT "seller_orders_fulfilment_fields_check";
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_fulfilment_fields_check" CHECK (
    ("fulfilment" = 'to-ship' AND "carrier" IS NULL AND "tracking_ref" IS NULL
      AND "shipped_at" IS NULL AND "delivered_at" IS NULL AND "inventory_recorded_at" IS NULL)
    OR ("fulfilment" = 'shipped' AND "carrier" IS NOT NULL AND "shipped_at" IS NOT NULL
      AND "delivered_at" IS NULL)
    OR ("fulfilment" = 'delivered' AND ("carrier" IS NOT NULL OR "delivery_method" = 'pickup')
      AND "shipped_at" IS NOT NULL
      AND "delivered_at" IS NOT NULL AND "delivered_at" >= "shipped_at")) NOT VALID;
ALTER TABLE "ordering"."seller_orders" VALIDATE CONSTRAINT "seller_orders_fulfilment_fields_check";

-- Grants. A code is created and changed (a new code, a counted failure, the lock) and never
-- deleted; the seller order it belongs to stays for ever, so no row is ever removed.
GRANT SELECT, INSERT, UPDATE ("code_hash", "code_sealed", "failed_attempts", "locked_at", "issued_at") ON TABLE "ordering"."pickup_codes" TO "mondapac_app";
