-- Abandoned carts at the end of each Market day (dashboards v2, phase 2): a count of active carts
-- with lines, no order mark and no change for at least 24 h at the day's end, and their approximate
-- value (prices when added), written once by reporting's hourly snapshot job on the next Market day.
-- Aggregate only: no cart, account, guest, offer or seller id. Insert-only for the application (no
-- UPDATE or DELETE grant).
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "reporting"."daily_abandoned_carts" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "market_day" DATE NOT NULL,
    "cart_count" INTEGER NOT NULL,
    "approx_value_amount" BIGINT,
    "approx_value_currency" VARCHAR(3),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_abandoned_carts_pkey" PRIMARY KEY ("market_id","market_day")
);

ALTER TABLE "reporting"."daily_abandoned_carts"
  ADD CONSTRAINT "daily_abandoned_carts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "daily_abandoned_carts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "daily_abandoned_carts_cart_count_check" CHECK ("cart_count" >= 0),
  -- The value is both parts or neither (null: a line in another currency, no conversion).
  ADD CONSTRAINT "daily_abandoned_carts_value_check" CHECK (
    ("approx_value_amount" IS NULL AND "approx_value_currency" IS NULL)
    OR (
      "approx_value_amount" IS NOT NULL
      AND "approx_value_currency" IS NOT NULL
      AND "approx_value_amount" >= 0
      AND "approx_value_currency" ~ '^[A-Z]{3}$'
    )
  );

GRANT SELECT, INSERT ON TABLE "reporting"."daily_abandoned_carts" TO "mondapac_app";
