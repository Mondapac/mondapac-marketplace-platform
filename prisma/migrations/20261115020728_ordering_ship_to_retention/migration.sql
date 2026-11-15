-- The ship-to retention setting of a Market (owner decision 2026-11-15): whether, and how many
-- months after the last delivery, the sealed delivery address of an order is deleted. One row per
-- Market, set by an admin; no row is off. New table, plus a column grant on ordering.orders so the
-- daily purge job may clear the sealed ship-to.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "ordering"."ship_to_retention_settings" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "months" INTEGER NOT NULL DEFAULT 24,
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_account_id" UUID NOT NULL,

    CONSTRAINT "ship_to_retention_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ship_to_retention_settings_market_id_key" ON "ordering"."ship_to_retention_settings"("market_id");

ALTER TABLE "ordering"."ship_to_retention_settings"
  ADD CONSTRAINT "ship_to_retention_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "ship_to_retention_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "ship_to_retention_settings_months_check" CHECK ("months" BETWEEN 1 AND 120),
  ADD CONSTRAINT "ship_to_retention_settings_version_check" CHECK ("version" >= 1);

-- The row is inserted once and then edited (never its id or Market); it is never deleted.
GRANT SELECT, INSERT, UPDATE ("enabled", "months", "version", "updated_at", "updated_by_account_id")
  ON TABLE "ordering"."ship_to_retention_settings" TO "mondapac_app";

-- The purge clears the sealed ship-to of delivered orders. The column CHECK already allows null
-- (orders placed before the address was recorded); the application only ever writes null here.
GRANT UPDATE ("ship_to_ciphertext") ON TABLE "ordering"."orders" TO "mondapac_app";
