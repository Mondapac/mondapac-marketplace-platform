-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "engagement";

-- CreateTable
CREATE TABLE "engagement"."behaviour_events" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID,
    "guest_hash" CHAR(64),
    "kind" VARCHAR(32) NOT NULL,
    "product_id" UUID,
    "offer_id" UUID,
    "variant_id" UUID,
    "category_id" UUID,
    "search_query" VARCHAR(200),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "behaviour_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement"."personalization_settings" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "personalization_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "behaviour_events_market_id_account_id_occurred_at_idx" ON "engagement"."behaviour_events"("market_id", "account_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "behaviour_events_market_id_guest_hash_occurred_at_idx" ON "engagement"."behaviour_events"("market_id", "guest_hash", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "behaviour_events_market_id_occurred_at_idx" ON "engagement"."behaviour_events"("market_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "personalization_settings_market_id_account_id_key" ON "engagement"."personalization_settings"("market_id", "account_id");


-- Hand-written: scope, subject, kind and per-kind shape checks.
ALTER TABLE "engagement"."behaviour_events"
  ADD CONSTRAINT "behaviour_events_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "behaviour_events_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "behaviour_events_subject_check" CHECK (("account_id" IS NULL) <> ("guest_hash" IS NULL)),
  ADD CONSTRAINT "behaviour_events_guest_hash_check" CHECK ("guest_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "behaviour_events_kind_check" CHECK ("kind" IN ('product-viewed', 'category-viewed', 'search-performed', 'added-to-cart')),
  ADD CONSTRAINT "behaviour_events_shape_check" CHECK (
    CASE "kind"
      WHEN 'product-viewed' THEN "product_id" IS NOT NULL AND "variant_id" IS NULL AND "category_id" IS NULL AND "search_query" IS NULL
      WHEN 'category-viewed' THEN "category_id" IS NOT NULL AND "product_id" IS NULL AND "offer_id" IS NULL AND "variant_id" IS NULL AND "search_query" IS NULL
      WHEN 'search-performed' THEN "search_query" IS NOT NULL AND "product_id" IS NULL AND "offer_id" IS NULL AND "variant_id" IS NULL AND "category_id" IS NULL
      WHEN 'added-to-cart' THEN "offer_id" IS NOT NULL AND "variant_id" IS NOT NULL AND "product_id" IS NULL AND "category_id" IS NULL AND "search_query" IS NULL
    END
  ),
  ADD CONSTRAINT "behaviour_events_search_query_check" CHECK (char_length("search_query") BETWEEN 1 AND 200 AND "search_query" = btrim("search_query"));

ALTER TABLE "engagement"."personalization_settings"
  ADD CONSTRAINT "personalization_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "personalization_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "personalization_settings_changed_at_check" CHECK ("changed_at" >= "created_at");

-- Grants. An event is inserted and deleted (retention purge, switch off, account deletion), never
-- changed. The switch is inserted, changed (enabled, time) and deleted with the account.
GRANT USAGE ON SCHEMA "engagement" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "engagement"."behaviour_events" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("enabled", "changed_at"), DELETE ON TABLE "engagement"."personalization_settings" TO "mondapac_app";
