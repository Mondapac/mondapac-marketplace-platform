-- The shopping funnel of each Market day (dashboards v2, phase 2): four counts of distinct signed-in
-- customers with personalization on, written once by reporting's hourly snapshot job, at least 2 h after
-- the Market day ends. Aggregate only: no account, guest, offer or seller id. Insert-only for the application (no
-- UPDATE or DELETE grant), so a customer's later opt-out or erasure never needs to touch it.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "reporting"."daily_engagement" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "market_day" DATE NOT NULL,
    "viewed_count" INTEGER NOT NULL,
    "carted_count" INTEGER NOT NULL,
    "checkout_count" INTEGER NOT NULL,
    "paid_count" INTEGER NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_engagement_pkey" PRIMARY KEY ("market_id","market_day")
);

ALTER TABLE "reporting"."daily_engagement"
  ADD CONSTRAINT "daily_engagement_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "daily_engagement_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- Each step counts only accounts of the step before, so the counts never go up.
  ADD CONSTRAINT "daily_engagement_steps_check" CHECK (
    "paid_count" >= 0
    AND "checkout_count" >= "paid_count"
    AND "carted_count" >= "checkout_count"
    AND "viewed_count" >= "carted_count"
  );

GRANT SELECT, INSERT ON TABLE "reporting"."daily_engagement" TO "mondapac_app";
