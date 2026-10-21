-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "cart"."saved_items" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "saved_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saved_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_items_market_id_account_id_saved_at_idx" ON "cart"."saved_items"("market_id", "account_id", "saved_at");

-- CreateIndex
CREATE INDEX "saved_items_market_id_saved_at_idx" ON "cart"."saved_items"("market_id", "saved_at");

-- CreateIndex
CREATE UNIQUE INDEX "saved_items_market_id_account_id_offer_id_variant_id_key" ON "cart"."saved_items"("market_id", "account_id", "offer_id", "variant_id");

-- Hand-written: scope checks, as on the other cart tables.
ALTER TABLE "cart"."saved_items"
  ADD CONSTRAINT "saved_items_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "saved_items_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

-- Hand-written: the API saves, reads, moves to the top (saved_at only) and deletes.
GRANT SELECT, INSERT, UPDATE ("saved_at"), DELETE ON TABLE "cart"."saved_items" TO "mondapac_app";
