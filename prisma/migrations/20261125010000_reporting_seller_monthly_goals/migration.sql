-- Dashboards v2, phase 2: a seller's own sales goal per calendar month (the seller dashboard's
-- "Monthly goal"). The first table of reporting that is not derived data: a seller sets it through
-- `reporting.set-seller-monthly-goal`, the history backfill never writes it. One new table; no
-- existing table changes, so no lock is taken on one.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "reporting"."seller_monthly_goals" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" BIGINT NOT NULL,
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_account_id" UUID NOT NULL,

    CONSTRAINT "seller_monthly_goals_pkey" PRIMARY KEY ("market_id","seller_id","month")
);

-- Hand-written: value checks. The month is stored as its first day; the amount is above zero and
-- at most 15 digits (inside a BIGINT, below 2^53), as the use case accepts it.
ALTER TABLE "reporting"."seller_monthly_goals"
  ADD CONSTRAINT "seller_monthly_goals_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_monthly_goals_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_monthly_goals_month_check" CHECK (EXTRACT(DAY FROM "month") = 1),
  ADD CONSTRAINT "seller_monthly_goals_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "seller_monthly_goals_amount_check" CHECK ("amount" > 0 AND "amount" < 1000000000000000),
  ADD CONSTRAINT "seller_monthly_goals_version_check" CHECK ("version" >= 1);

-- Grants. A goal is set and changed in place (its key never changes); nothing is deleted.
GRANT SELECT, INSERT, UPDATE ("currency", "amount", "version", "updated_at", "updated_by_account_id") ON TABLE "reporting"."seller_monthly_goals" TO "mondapac_app";
