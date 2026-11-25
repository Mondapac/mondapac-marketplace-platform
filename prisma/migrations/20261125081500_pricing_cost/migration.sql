-- Slice 3 of pricing: the Cost stream (docs/design/data/pricing.md 3.7, 6, 7; domain design 2.1,
-- 6.5). Two new tables only: no price table changes, and no Cost table relates to a price table.
-- Safety (data design 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "pricing"."cost_series" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "retired_at" TIMESTAMPTZ(6),
    "retire_cause" TEXT,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cost_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing"."cost_records" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cost_series_id" UUID NOT NULL,
    "series_version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_minor" BIGINT,
    "currency" CHAR(3) NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "submitted_by_account_id" UUID NOT NULL,

    CONSTRAINT "cost_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cost_series_market_id_product_id_variant_id_idx" ON "pricing"."cost_series"("market_id", "product_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_series_market_id_offer_id_variant_id_key" ON "pricing"."cost_series"("market_id", "offer_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_series_market_id_id_currency_key" ON "pricing"."cost_series"("market_id", "id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "cost_records_market_id_cost_series_id_series_version_key" ON "pricing"."cost_records"("market_id", "cost_series_id", "series_version");

-- AddForeignKey
ALTER TABLE "pricing"."cost_records" ADD CONSTRAINT "cost_records_cost_series_id_fkey" FOREIGN KEY ("market_id", "cost_series_id", "currency") REFERENCES "pricing"."cost_series"("market_id", "id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): data design 3.7, P1, P2 and C1. The series has the CHECKs of
-- price_series under its own names; a record is an amount or a "cleared" marker (Q7).
ALTER TABLE "pricing"."cost_series"
  ADD CONSTRAINT "cost_series_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "cost_series_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "cost_series_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "cost_series_retire_cause_check" CHECK (
    "retire_cause" IN ('offer-removed', 'variant-removed')),
  ADD CONSTRAINT "cost_series_retired_check" CHECK (
    ("retired_at" IS NULL) = ("retire_cause" IS NULL)
    AND ("retired_at" IS NULL OR "retired_at" >= "created_at")),
  ADD CONSTRAINT "cost_series_version_check" CHECK ("version" >= 1);

ALTER TABLE "pricing"."cost_records"
  ADD CONSTRAINT "cost_records_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "cost_records_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "cost_records_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "cost_records_kind_check" CHECK ("kind" IN ('amount', 'cleared')),
  ADD CONSTRAINT "cost_records_series_version_check" CHECK ("series_version" >= 1),
  ADD CONSTRAINT "cost_records_amount_minor_check" CHECK (
    ("amount_minor" IS NOT NULL) = ("kind" = 'amount')
    AND ("amount_minor" IS NULL OR ("amount_minor" > 0 AND "amount_minor" <= 9007199254740991)));

-- Hand-written (database-designer): data design 3.7 and P6. Cost records are append-only: no
-- update, no delete, no truncate, for every role, the owner included (23001). reject_mutation()
-- is the function of migration 20261008183000.
CREATE TRIGGER "cost_records_no_update_delete" BEFORE UPDATE OR DELETE ON "pricing"."cost_records"
  FOR EACH ROW EXECUTE FUNCTION "pricing"."reject_mutation"();
CREATE TRIGGER "cost_records_no_truncate" BEFORE TRUNCATE ON "pricing"."cost_records"
  FOR EACH STATEMENT EXECUTE FUNCTION "pricing"."reject_mutation"();

-- Grants (database-designer): data design 7, to mondapac_app only, option A of H-D1 (same group;
-- the boundary rule keeps the Cost models in infrastructure/cost/). A series' Offer, seller and
-- currency never change; records are insert-only.
GRANT SELECT, INSERT, UPDATE ("retired_at", "retire_cause", "version")
  ON TABLE "pricing"."cost_series" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "pricing"."cost_records" TO "mondapac_app";
