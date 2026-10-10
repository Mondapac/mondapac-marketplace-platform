-- AlterTable
ALTER TABLE "inventory"."stock_items" ADD COLUMN "hold_seq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "inventory"."reservations" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "holder_account_id" UUID NOT NULL,
    "checkout_ref" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "release_cause" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."reservation_lines" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "reservation_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "offer_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "order_line_id" UUID,
    "state_changed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reservation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."offer_purchase_limits" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "max_per_customer" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offer_purchase_limits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservations_market_id_id_expires_at_key" ON "inventory"."reservations"("market_id", "id", "expires_at");

-- CreateIndex
CREATE INDEX "reservation_lines_market_id_stock_item_id_state_idx" ON "inventory"."reservation_lines"("market_id", "stock_item_id", "state", "expires_at", "quantity");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_lines_market_id_reservation_id_offer_id_variant_key" ON "inventory"."reservation_lines"("market_id", "reservation_id", "offer_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_lines_market_id_order_line_id_key" ON "inventory"."reservation_lines"("market_id", "order_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "offer_purchase_limits_market_id_offer_id_key" ON "inventory"."offer_purchase_limits"("market_id", "offer_id");

-- AddForeignKey
ALTER TABLE "inventory"."reservation_lines" ADD CONSTRAINT "reservation_lines_market_id_reservation_id_expires_at_fkey" FOREIGN KEY ("market_id", "reservation_id", "expires_at") REFERENCES "inventory"."reservations"("market_id", "id", "expires_at") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory"."reservation_lines" ADD CONSTRAINT "reservation_lines_market_id_stock_item_id_offer_id_variant_fkey" FOREIGN KEY ("market_id", "stock_item_id", "offer_id", "variant_id") REFERENCES "inventory"."stock_items"("market_id", "id", "offer_id", "variant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written (database-designer): docs/design/data/inventory.md sections 2 (C1, C5, C6), 3.6,
-- 3.7 and 3.8. Only new tables, so nothing here is NOT VALID.
ALTER TABLE "inventory"."reservations"
  ADD CONSTRAINT "reservations_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "reservations_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "reservations_status_check" CHECK ("status" IN ('active', 'released', 'expired', 'committed')),
  ADD CONSTRAINT "reservations_release_cause_check" CHECK (
    ("status" = 'released' AND "release_cause" IS NOT NULL AND "release_cause" IN ('superseded', 'cancelled', 'payment-failed', 'customer', 'offer-moved'))
    OR ("status" = 'committed' AND ("release_cause" IS NULL OR "release_cause" = 'superseded'))
    OR ("status" IN ('active', 'expired') AND "release_cause" IS NULL)
  ),
  ADD CONSTRAINT "reservations_expires_at_check" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "reservations_status_changed_at_check" CHECK ("status_changed_at" >= "created_at"),
  ADD CONSTRAINT "reservations_version_check" CHECK ("version" >= 1);

ALTER TABLE "inventory"."reservation_lines"
  ADD CONSTRAINT "reservation_lines_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "reservation_lines_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "reservation_lines_quantity_check" CHECK ("quantity" >= 1),
  ADD CONSTRAINT "reservation_lines_state_check" CHECK ("state" IN ('active', 'released', 'expired', 'committed', 'fulfilled', 'cancelled')),
  ADD CONSTRAINT "reservation_lines_order_line_id_check" CHECK (("order_line_id" IS NULL) = ("state" IN ('active', 'released', 'expired')));

ALTER TABLE "inventory"."offer_purchase_limits"
  ADD CONSTRAINT "offer_purchase_limits_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_purchase_limits_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_purchase_limits_max_per_customer_check" CHECK ("max_per_customer" >= 1),
  ADD CONSTRAINT "offer_purchase_limits_version_check" CHECK ("version" >= 1);

-- Hand-written (database-designer): docs/design/data/inventory.md section 8.4. Invisible to
-- Prisma; checked by the partial-index catalog test. One ACTIVE reservation per holder (the same
-- index answers the idempotent reserve) and the expiry job's candidates.
CREATE UNIQUE INDEX "reservations_market_id_holder_account_id_active_key" ON "inventory"."reservations" ("market_id", "holder_account_id") WHERE "status" = 'active';
CREATE INDEX "reservations_market_id_expires_at_active_idx" ON "inventory"."reservations" ("market_id", "expires_at") WHERE "status" = 'active';

-- Grants (database-designer): docs/design/data/inventory.md section 7. Column-level UPDATE on
-- the two reservation tables (expires_at, quantity, offer_id and variant_id are immutable; stock_item_id is updatable for the
-- rekey of a moved Offer); no
-- DELETE on reservations until the prune job (migration 4); lines are deleted only by the
-- cascade, which needs no grant on the child.
GRANT SELECT, INSERT, UPDATE ("status", "release_cause", "status_changed_at", "version") ON TABLE "inventory"."reservations" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("stock_item_id", "state", "order_line_id", "state_changed_at") ON TABLE "inventory"."reservation_lines" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("max_per_customer", "version"), DELETE ON TABLE "inventory"."offer_purchase_limits" TO "mondapac_app";
-- hold_seq: raised by every unit that changes holds (H1); a separate column from version (C5).
GRANT UPDATE ("hold_seq") ON TABLE "inventory"."stock_items" TO "mondapac_app";
