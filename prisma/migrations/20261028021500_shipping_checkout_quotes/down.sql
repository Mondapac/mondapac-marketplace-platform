-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261025160000_shipping_checkout_quotes. The quotes, the fleet fees, the fallbacks and
-- the quote kept on each seller order are lost. The flat fees and the delivery terms that were
-- dropped come back as empty structure: no seller has a fee or terms until one is set again.
ALTER TABLE "ordering"."seller_orders" DROP CONSTRAINT "seller_orders_delivery_quote_check";
ALTER TABLE "ordering"."seller_orders" DROP COLUMN "delivery_quoted_at",
DROP COLUMN "delivery_quote_id",
DROP COLUMN "delivery_quote_fleet",
DROP COLUMN "delivery_quote_expires_at",
DROP COLUMN "delivery_quote_amount",
DROP COLUMN "delivery_margin_amount";

DROP TABLE "shipping"."delivery_fallbacks";
DROP TABLE "shipping"."fleet_fees";
DROP TABLE "shipping"."delivery_quotes";

ALTER TABLE "sellers"."store_profiles" ADD COLUMN     "delivery_changed_at" TIMESTAMPTZ(6),
ADD COLUMN     "delivery_changed_by_account_id" UUID,
ADD COLUMN     "delivery_day" VARCHAR(8),
ADD COLUMN     "delivery_from_minute" SMALLINT,
ADD COLUMN     "delivery_to_minute" SMALLINT,
ADD COLUMN     "order_cutoff_minute" SMALLINT;
ALTER TABLE "sellers"."store_profiles"
  ADD CONSTRAINT "store_profiles_delivery_set_check" CHECK (("delivery_day" IS NULL) = ("delivery_from_minute" IS NULL) AND ("delivery_day" IS NULL) = ("delivery_to_minute" IS NULL) AND ("delivery_day" IS NULL) = ("order_cutoff_minute" IS NULL)),
  ADD CONSTRAINT "store_profiles_delivery_day_check" CHECK ("delivery_day" IN ('same-day', 'next-day')),
  ADD CONSTRAINT "store_profiles_delivery_window_check" CHECK ("delivery_from_minute" >= 0 AND "delivery_to_minute" <= 1440 AND "delivery_from_minute" < "delivery_to_minute" AND "delivery_from_minute" % 30 = 0 AND "delivery_to_minute" % 30 = 0),
  ADD CONSTRAINT "store_profiles_delivery_cutoff_check" CHECK ("order_cutoff_minute" >= 0 AND "order_cutoff_minute" < 1440 AND "order_cutoff_minute" % 30 = 0 AND ("delivery_day" <> 'same-day' OR "order_cutoff_minute" < "delivery_to_minute")),
  ADD CONSTRAINT "store_profiles_delivery_changed_check" CHECK (("delivery_changed_at" IS NULL) = ("delivery_changed_by_account_id" IS NULL)),
  ADD CONSTRAINT "store_profiles_delivery_set_changed_check" CHECK ("delivery_day" IS NULL OR "delivery_changed_at" IS NOT NULL);

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
ALTER TABLE "shipping"."seller_flat_fees"
  ADD CONSTRAINT "seller_flat_fees_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_flat_fees_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_flat_fees_amount_check" CHECK ("amount" BETWEEN 0 AND 100000),
  ADD CONSTRAINT "seller_flat_fees_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
GRANT SELECT, INSERT, UPDATE ("amount", "currency", "updated_at", "updated_by") ON TABLE "shipping"."seller_flat_fees" TO "mondapac_app";
