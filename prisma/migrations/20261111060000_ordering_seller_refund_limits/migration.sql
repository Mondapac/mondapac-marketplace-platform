-- Caps on the refunds a seller starts by marking units unavailable (order detail decision 6;
-- Hassan F2; owner decision 2026-11-11): a count and an amount in any 24 hours, a Market default
-- and per-seller rows set by an admin, and one guard row per seller under whose lock the seller's
-- refunds are counted (and the admin alert is sent at most once a day). New tables only.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "ordering"."seller_refund_limits" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID,
    "max_count" INTEGER NOT NULL,
    "max_amount" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_account_id" UUID NOT NULL,

    CONSTRAINT "seller_refund_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordering"."seller_refund_guards" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL,
    "last_alerted_at" TIMESTAMPTZ(6),
    "alerts" INTEGER NOT NULL,

    CONSTRAINT "seller_refund_guards_pkey" PRIMARY KEY ("market_id","seller_id")
);

ALTER TABLE "ordering"."seller_refund_limits"
  ADD CONSTRAINT "seller_refund_limits_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_refund_limits_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_refund_limits_max_count_check" CHECK ("max_count" BETWEEN 1 AND 1000),
  ADD CONSTRAINT "seller_refund_limits_max_amount_check" CHECK ("max_amount" > 0),
  ADD CONSTRAINT "seller_refund_limits_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "seller_refund_limits_version_check" CHECK ("version" >= 1);

ALTER TABLE "ordering"."seller_refund_guards"
  ADD CONSTRAINT "seller_refund_guards_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_refund_guards_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_refund_guards_alerts_check" CHECK ("alerts" >= 0),
  ADD CONSTRAINT "seller_refund_guards_alerted_check" CHECK (("alerts" = 0) = ("last_alerted_at" IS NULL));

-- One Market default and one row per seller.
CREATE UNIQUE INDEX "seller_refund_limits_default_key" ON "ordering"."seller_refund_limits" ("market_id")
  WHERE "seller_id" IS NULL;
CREATE UNIQUE INDEX "seller_refund_limits_seller_key" ON "ordering"."seller_refund_limits" ("market_id", "seller_id")
  WHERE "seller_id" IS NOT NULL;

-- The 24-hour count of a seller's own refunds, read under the guard's lock on every seller refund.
CREATE INDEX "refunds_seller_requested_at_idx" ON "ordering"."refunds" ("market_id", "seller_id", "requested_at")
  WHERE "actor_population" = 'seller';

GRANT SELECT, INSERT, UPDATE ("max_count", "max_amount", "currency", "version", "updated_at", "updated_by_account_id"), DELETE
  ON TABLE "ordering"."seller_refund_limits" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("checked_at", "last_alerted_at", "alerts")
  ON TABLE "ordering"."seller_refund_guards" TO "mondapac_app";
