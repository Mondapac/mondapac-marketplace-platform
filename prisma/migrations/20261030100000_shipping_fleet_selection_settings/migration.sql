-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Settings S4, fleet selection: the page version. The fleet-selection page saves the active model
-- per delivery method and the reliability score per fleet in one batch; this row holds the one
-- version of that page per Market, so a stale page is refused (compare-and-bump). No row means
-- version 0 (nothing saved through the batch yet), so the migration needs no backfill.

-- CreateTable
CREATE TABLE "shipping"."fleet_selection_settings" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "fleet_selection_settings_pkey" PRIMARY KEY ("market_id")
);

-- Hand-written: scope and value checks of the new table (empty, so no NOT VALID step).
ALTER TABLE "shipping"."fleet_selection_settings"
  ADD CONSTRAINT "fleet_selection_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "fleet_selection_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "fleet_selection_settings_version_check" CHECK ("version" >= 1);

-- Grants. The row is written once (the first save) and its version is raised after; never deleted.
GRANT SELECT, INSERT, UPDATE ("version", "updated_at", "updated_by") ON TABLE "shipping"."fleet_selection_settings" TO "mondapac_app";
