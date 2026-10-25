-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "ordering"."offer_pairs" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "paired_offer_id" UUID NOT NULL,
    "orders" INTEGER NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offer_pairs_pkey" PRIMARY KEY ("market_id","offer_id","paired_offer_id")
);

-- Hand-written: scope, a pair is of two different Offers and holds at least the 3 distinct paid
-- orders the shelf needs (personalization decision 1).
ALTER TABLE "ordering"."offer_pairs"
  ADD CONSTRAINT "offer_pairs_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_pairs_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_pairs_distinct_check" CHECK ("offer_id" <> "paired_offer_id"),
  ADD CONSTRAINT "offer_pairs_orders_check" CHECK ("orders" >= 3);

-- Grants. The nightly job deletes a Market's rows and inserts the new ones; a row is never changed.
GRANT SELECT, INSERT, DELETE ON TABLE "ordering"."offer_pairs" TO "mondapac_app";
