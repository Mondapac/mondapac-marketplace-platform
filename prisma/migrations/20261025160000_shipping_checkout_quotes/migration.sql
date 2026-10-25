-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Delivery models, package 5: the buyer pays the fleet's live quote plus the platform's margin, and
-- the seller no longer sets a delivery fee or a delivery window.
--
-- 1. REMOVED. The seller flat fees (shipping.seller_flat_fees) and the delivery terms a seller set
--    on the store profile (day, window, order cut-off: six columns of sellers.store_profiles).
--    Nothing reads them any more. The data is dropped; down.sql restores the empty structure.
-- 2. ADDED. shipping.delivery_quotes (the quote a buyer is shown and charged), shipping.fleet_fees
--    (the fees a fleet charges the platform) and shipping.delivery_fallbacks (a booking given to
--    another fleet than the one charged); and, per seller order, the quote that was charged.

-- DropTable
DROP TABLE "shipping"."seller_flat_fees";

-- Hand-written: the delivery-terms CHECKs go before their columns.
ALTER TABLE "sellers"."store_profiles"
  DROP CONSTRAINT "store_profiles_delivery_set_changed_check",
  DROP CONSTRAINT "store_profiles_delivery_changed_check",
  DROP CONSTRAINT "store_profiles_delivery_cutoff_check",
  DROP CONSTRAINT "store_profiles_delivery_window_check",
  DROP CONSTRAINT "store_profiles_delivery_day_check",
  DROP CONSTRAINT "store_profiles_delivery_set_check";

-- AlterTable
ALTER TABLE "sellers"."store_profiles" DROP COLUMN "delivery_changed_at",
DROP COLUMN "delivery_changed_by_account_id",
DROP COLUMN "delivery_day",
DROP COLUMN "delivery_from_minute",
DROP COLUMN "delivery_to_minute",
DROP COLUMN "order_cutoff_minute";

-- CreateTable
CREATE TABLE "shipping"."delivery_quotes" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "dropoff_postcode" VARCHAR(16) NOT NULL,
    "fleet" TEXT NOT NULL,
    "quote_amount" BIGINT NOT NULL,
    "margin_amount" BIGINT NOT NULL,
    "total_amount" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "eta_minutes" INTEGER,
    "quoted_at" TIMESTAMPTZ(6) NOT NULL,
    "fleet_expires_at" TIMESTAMPTZ(6),
    "valid_until" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "delivery_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping"."fleet_fees" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "fleet" TEXT NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "external_ref" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fleet_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping"."delivery_fallbacks" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "charged_fleet" TEXT NOT NULL,
    "booked_fleet" TEXT NOT NULL,
    "charged_quote" BIGINT NOT NULL,
    "booked_price" BIGINT,
    "difference" BIGINT,
    "cap_minor" INTEGER NOT NULL,
    "over_cap" BOOLEAN NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "delivery_fallbacks_pkey" PRIMARY KEY ("market_id","seller_order_id")
);

-- AlterTable
ALTER TABLE "ordering"."seller_orders" ADD COLUMN     "delivery_margin_amount" BIGINT,
ADD COLUMN     "delivery_quote_amount" BIGINT,
ADD COLUMN     "delivery_quote_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "delivery_quote_fleet" TEXT,
ADD COLUMN     "delivery_quote_id" UUID,
ADD COLUMN     "delivery_quoted_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "delivery_quotes_market_id_account_id_seller_id_method_quote_idx" ON "shipping"."delivery_quotes"("market_id", "account_id", "seller_id", "method", "quoted_at");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_quotes_market_id_id_key" ON "shipping"."delivery_quotes"("market_id", "id");

-- CreateIndex
CREATE INDEX "fleet_fees_market_id_seller_order_id_idx" ON "shipping"."fleet_fees"("market_id", "seller_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_fees_market_id_fleet_external_ref_key" ON "shipping"."fleet_fees"("market_id", "fleet", "external_ref");

-- Hand-written: scope and value checks of the new tables (empty, so no NOT VALID step).
ALTER TABLE "shipping"."delivery_quotes"
  ADD CONSTRAINT "delivery_quotes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "delivery_quotes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "delivery_quotes_method_check" CHECK ("method" IN ('instant', 'same_day', 'scheduled')),
  ADD CONSTRAINT "delivery_quotes_fleet_check" CHECK ("fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'auspost', 'fake_test')),
  ADD CONSTRAINT "delivery_quotes_amounts_check" CHECK (
    "quote_amount" >= 0 AND "margin_amount" >= 0 AND "total_amount" = "quote_amount" + "margin_amount"),
  ADD CONSTRAINT "delivery_quotes_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "delivery_quotes_eta_check" CHECK ("eta_minutes" IS NULL OR "eta_minutes" >= 0),
  ADD CONSTRAINT "delivery_quotes_valid_until_check" CHECK ("valid_until" > "quoted_at"),
  ADD CONSTRAINT "delivery_quotes_postcode_check" CHECK ("dropoff_postcode" ~ '^[\x20-\x7e]{1,16}$');
ALTER TABLE "shipping"."fleet_fees"
  ADD CONSTRAINT "fleet_fees_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "fleet_fees_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "fleet_fees_fleet_check" CHECK ("fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'auspost', 'fake_test')),
  ADD CONSTRAINT "fleet_fees_reason_check" CHECK ("reason" IN ('cancel', 'waiting', 'return', 'other')),
  ADD CONSTRAINT "fleet_fees_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "fleet_fees_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "fleet_fees_external_ref_check" CHECK (char_length("external_ref") BETWEEN 1 AND 120);
ALTER TABLE "shipping"."delivery_fallbacks"
  ADD CONSTRAINT "delivery_fallbacks_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "delivery_fallbacks_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "delivery_fallbacks_fleets_check" CHECK (
    "charged_fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'auspost', 'fake_test')
    AND "booked_fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'auspost', 'fake_test')
    AND "charged_fleet" <> "booked_fleet"),
  ADD CONSTRAINT "delivery_fallbacks_amounts_check" CHECK (
    "charged_quote" >= 0 AND "cap_minor" >= 0
    AND (("booked_price" IS NULL AND "difference" IS NULL AND "over_cap")
      OR ("booked_price" IS NOT NULL AND "difference" IS NOT NULL
        AND "booked_price" >= 0 AND "difference" >= 0))),
  ADD CONSTRAINT "delivery_fallbacks_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');

-- Hand-written: the quote of a seller order is all there or all absent (a pickup, and an order
-- placed before quotes were kept, have none); the buyer paid its price plus its margin.
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_delivery_quote_check" CHECK (
    ("delivery_quote_id" IS NULL AND "delivery_quote_fleet" IS NULL AND "delivery_quote_amount" IS NULL
      AND "delivery_margin_amount" IS NULL AND "delivery_quoted_at" IS NULL AND "delivery_quote_expires_at" IS NULL)
    OR ("delivery_quote_id" IS NOT NULL AND "delivery_quote_fleet" IS NOT NULL
      AND "delivery_quote_amount" IS NOT NULL AND "delivery_margin_amount" IS NOT NULL
      AND "delivery_quote_fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'auspost', 'fake_test')
      AND "delivery_quote_amount" >= 0 AND "delivery_margin_amount" >= 0
      AND "delivery_quoted_at" IS NOT NULL AND "delivery_quote_expires_at" IS NOT NULL
      AND "shipping_amount" = "delivery_quote_amount" + "delivery_margin_amount")) NOT VALID;
ALTER TABLE "ordering"."seller_orders" VALIDATE CONSTRAINT "seller_orders_delivery_quote_check";

-- Grants. A quote is written once and its owner's expired ones are removed; a fee is written once; a
-- fallback is written once per seller order. Nothing changes after it is written.
GRANT SELECT, INSERT, DELETE ON TABLE "shipping"."delivery_quotes" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "shipping"."fleet_fees" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "shipping"."delivery_fallbacks" TO "mondapac_app";
