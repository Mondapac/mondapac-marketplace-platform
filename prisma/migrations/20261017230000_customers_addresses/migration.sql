-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "customers";

-- CreateTable
CREATE TABLE "customers"."addresses" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "content_ciphertext" TEXT NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "addresses_market_id_account_id_created_at_id_idx" ON "customers"."addresses"("market_id", "account_id", "created_at" DESC, "id" DESC);

-- Hand-written: at most one default address per customer.
CREATE UNIQUE INDEX "addresses_one_default_key" ON "customers"."addresses" ("market_id", "account_id") WHERE "is_default";

-- Hand-written: scope and value checks. The address itself is a ciphertext the database never
-- reads; it keeps the sealed format (platform subject keys, v<N>.<base64url>).
ALTER TABLE "customers"."addresses"
  ADD CONSTRAINT "addresses_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "addresses_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "addresses_country_code_check" CHECK ("country_code" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "addresses_content_ciphertext_check" CHECK (
    "content_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("content_ciphertext") BETWEEN 41 AND 8192);

-- Grants. An address is inserted, changed (content, default flag) and removed by its customer.
GRANT USAGE ON SCHEMA "customers" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("content_ciphertext", "is_default", "updated_at"), DELETE ON TABLE "customers"."addresses" TO "mondapac_app";
