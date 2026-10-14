-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "shipping";

-- CreateTable
CREATE TABLE "shipping"."seller_flat_fees" (
    "market_id" VARCHAR(8) NOT NULL,
    "seller_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "seller_flat_fees_pkey" PRIMARY KEY ("market_id","seller_id")
);

-- Hand-written: scope and value checks.
ALTER TABLE "shipping"."seller_flat_fees"
  ADD CONSTRAINT "seller_flat_fees_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_flat_fees_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_flat_fees_amount_check" CHECK ("amount" BETWEEN 0 AND 100000),
  ADD CONSTRAINT "seller_flat_fees_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');

-- Grants. The application inserts a row once and updates the fee columns; it never deletes one.
GRANT USAGE ON SCHEMA "shipping" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("amount", "currency", "updated_at", "updated_by") ON TABLE "shipping"."seller_flat_fees" TO "mondapac_app";
