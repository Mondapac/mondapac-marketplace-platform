-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "cart";

-- CreateTable
CREATE TABLE "cart"."carts" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID,
    "guest_token_hash" BYTEA,
    "status" TEXT NOT NULL,
    "last_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "merged_into_cart_id" UUID,
    "merged_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart"."cart_lines" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cart_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price_at_add_amount" BIGINT NOT NULL,
    "price_at_add_currency" VARCHAR(3) NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cart_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "carts_market_id_guest_token_hash_idx" ON "cart"."carts"("market_id", "guest_token_hash");

-- CreateIndex
CREATE INDEX "carts_market_id_account_id_idx" ON "cart"."carts"("market_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "carts_market_id_id_key" ON "cart"."carts"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cart_lines_market_id_cart_id_offer_id_variant_id_key" ON "cart"."cart_lines"("market_id", "cart_id", "offer_id", "variant_id");

-- AddForeignKey
ALTER TABLE "cart"."cart_lines" ADD CONSTRAINT "cart_lines_market_id_cart_id_fkey" FOREIGN KEY ("market_id", "cart_id") REFERENCES "cart"."carts"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written: scope, ownership and value checks (cart design 2.1, 11, simplified).
ALTER TABLE "cart"."carts"
  ADD CONSTRAINT "carts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "carts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "carts_status_check" CHECK ("status" IN ('active', 'merged')),
  ADD CONSTRAINT "carts_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "carts_guest_token_hash_check" CHECK (
    "guest_token_hash" IS NULL OR octet_length("guest_token_hash") = 32),
  -- Exactly one owner while active; a merged cart keeps its guest hash so a replay is recognised.
  ADD CONSTRAINT "carts_owner_check" CHECK (
    ("status" = 'active' AND (("account_id" IS NULL) <> ("guest_token_hash" IS NULL)))
    OR ("status" = 'merged' AND "guest_token_hash" IS NOT NULL AND "account_id" IS NULL)),
  ADD CONSTRAINT "carts_merged_check" CHECK (
    ("status" = 'merged') = ("merged_into_cart_id" IS NOT NULL AND "merged_at" IS NOT NULL)
    OR ("status" = 'active' AND "merged_into_cart_id" IS NULL AND "merged_at" IS NULL));

ALTER TABLE "cart"."cart_lines"
  ADD CONSTRAINT "cart_lines_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "cart_lines_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "cart_lines_quantity_check" CHECK ("quantity" BETWEEN 1 AND 999),
  ADD CONSTRAINT "cart_lines_price_at_add_check" CHECK (
    "price_at_add_amount" >= 0 AND "price_at_add_currency" ~ '^[A-Z]{3}$');

-- Hand-written: one active cart per account, one cart per guest token. Invisible to Prisma.
CREATE UNIQUE INDEX "carts_market_id_account_id_active_key" ON "cart"."carts" ("market_id", "account_id") WHERE "account_id" IS NOT NULL AND "status" = 'active';
CREATE UNIQUE INDEX "carts_market_id_guest_token_hash_key" ON "cart"."carts" ("market_id", "guest_token_hash") WHERE "guest_token_hash" IS NOT NULL;

-- Grants. Lines are deleted by remove and by merge; carts are never deleted by the application
-- (the purge job arrives with retention).
GRANT USAGE ON SCHEMA "cart" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("account_id", "guest_token_hash", "status", "last_changed_at", "merged_into_cart_id", "merged_at", "version") ON TABLE "cart"."carts" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("quantity", "price_at_add_amount", "price_at_add_currency", "added_at"), DELETE ON TABLE "cart"."cart_lines" TO "mondapac_app";
