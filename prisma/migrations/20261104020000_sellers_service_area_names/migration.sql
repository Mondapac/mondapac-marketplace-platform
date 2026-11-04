-- Editable service area names (ADR-0041; seller-city package 4). Creates
-- sellers.service_area_names. Nothing is backfilled: no row means the configured name. Safety: a
-- blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "sellers"."service_area_names" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "area_code" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_area_names_pkey" PRIMARY KEY ("market_id","area_code","locale")
);

-- Hand-written: CHECKs. The same shapes the configuration boot check holds (area code, language
-- tag, 1 to 120 characters).
ALTER TABLE "sellers"."service_area_names"
  ADD CONSTRAINT "service_area_names_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "service_area_names_area_code_check" CHECK ("area_code" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT "service_area_names_locale_check" CHECK ("locale" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  ADD CONSTRAINT "service_area_names_name_check" CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 120);

-- Grants (database-designer). A name is replaced by changing the name, who and when; deleting the
-- row restores the configured name. The key columns never change.
GRANT SELECT, INSERT, DELETE, UPDATE ("name", "updated_by", "updated_at")
  ON TABLE "sellers"."service_area_names" TO "mondapac_app";
