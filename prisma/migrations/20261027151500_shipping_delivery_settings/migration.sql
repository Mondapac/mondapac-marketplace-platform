-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Delivery models, package 4: the delivery settings an admin sets. One row per Market for the
-- platform-wide switches, the same-day cut-off, the scheduled days ahead and window length and
-- the margin on a fleet's quote; one row per seller for the methods an admin took away from it.
-- No row means the defaults of the domain, so the migration needs no backfill: every Market and
-- every existing seller keeps every method it had.

-- CreateTable
CREATE TABLE "shipping"."delivery_settings" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "pickup_enabled" BOOLEAN NOT NULL,
    "instant_enabled" BOOLEAN NOT NULL,
    "same_day_enabled" BOOLEAN NOT NULL,
    "scheduled_enabled" BOOLEAN NOT NULL,
    "same_day_cutoff_minutes" INTEGER NOT NULL,
    "scheduled_days_ahead" INTEGER NOT NULL,
    "scheduled_window_minutes" INTEGER NOT NULL,
    "margin_kind" TEXT NOT NULL,
    "margin_basis_points" INTEGER,
    "margin_fixed_minor" INTEGER,
    "rounding_step_minor" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "delivery_settings_pkey" PRIMARY KEY ("market_id")
);

-- CreateTable
CREATE TABLE "shipping"."seller_delivery_methods" (
    "market_id" VARCHAR(8) NOT NULL,
    "seller_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "unsupported" TEXT[],
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "seller_delivery_methods_pkey" PRIMARY KEY ("market_id","seller_id")
);

-- Hand-written: scope and value checks of the new tables (empty, so no NOT VALID step).
ALTER TABLE "shipping"."delivery_settings"
  ADD CONSTRAINT "delivery_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "delivery_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "delivery_settings_cutoff_check" CHECK ("same_day_cutoff_minutes" BETWEEN 0 AND 1439),
  ADD CONSTRAINT "delivery_settings_days_ahead_check" CHECK ("scheduled_days_ahead" BETWEEN 1 AND 30),
  ADD CONSTRAINT "delivery_settings_window_check" CHECK ("scheduled_window_minutes" BETWEEN 30 AND 480 AND "scheduled_window_minutes" % 15 = 0),
  ADD CONSTRAINT "delivery_settings_margin_check" CHECK (
    ("margin_kind" = 'none' AND "margin_basis_points" IS NULL AND "margin_fixed_minor" IS NULL)
    OR ("margin_kind" = 'percent' AND "margin_basis_points" IS NOT NULL AND "margin_basis_points" BETWEEN 0 AND 10000 AND "margin_fixed_minor" IS NULL)
    OR ("margin_kind" = 'fixed' AND "margin_fixed_minor" IS NOT NULL AND "margin_fixed_minor" BETWEEN 0 AND 1000000 AND "margin_basis_points" IS NULL)),
  ADD CONSTRAINT "delivery_settings_rounding_check" CHECK ("rounding_step_minor" IN (1, 5, 10, 50, 100)),
  ADD CONSTRAINT "delivery_settings_version_check" CHECK ("version" >= 1);
ALTER TABLE "shipping"."seller_delivery_methods"
  ADD CONSTRAINT "seller_delivery_methods_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_delivery_methods_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_delivery_methods_unsupported_check" CHECK (
    "unsupported" <@ ARRAY['pickup', 'instant', 'same_day', 'scheduled']::TEXT[]
    AND cardinality("unsupported") <= 4);

-- Grants. A row is written once and changed; neither table is ever deleted from.
GRANT SELECT, INSERT, UPDATE ("pickup_enabled", "instant_enabled", "same_day_enabled", "scheduled_enabled", "same_day_cutoff_minutes", "scheduled_days_ahead", "scheduled_window_minutes", "margin_kind", "margin_basis_points", "margin_fixed_minor", "rounding_step_minor", "version", "updated_at", "updated_by") ON TABLE "shipping"."delivery_settings" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("unsupported", "updated_at", "updated_by") ON TABLE "shipping"."seller_delivery_methods" TO "mondapac_app";
