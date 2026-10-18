-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "legal";

-- CreateTable
CREATE TABLE "legal"."marketing_consents" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "channel" VARCHAR(16) NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "marketing_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal"."marketing_consent_changes" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "channel" VARCHAR(16) NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "marketing_consent_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "marketing_consents_market_id_account_id_channel_key" ON "legal"."marketing_consents"("market_id", "account_id", "channel");

-- CreateIndex
CREATE INDEX "marketing_consent_changes_market_id_account_id_occurred_at__idx" ON "legal"."marketing_consent_changes"("market_id", "account_id", "occurred_at" DESC, "id" DESC);

-- Hand-written: scope and value checks.
ALTER TABLE "legal"."marketing_consents"
  ADD CONSTRAINT "marketing_consents_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "marketing_consents_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "marketing_consents_channel_check" CHECK ("channel" IN ('email')),
  ADD CONSTRAINT "marketing_consents_source_check" CHECK ("source" IN ('sign-up', 'account', 'unsubscribe-link'));

ALTER TABLE "legal"."marketing_consent_changes"
  ADD CONSTRAINT "marketing_consent_changes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "marketing_consent_changes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "marketing_consent_changes_channel_check" CHECK ("channel" IN ('email')),
  ADD CONSTRAINT "marketing_consent_changes_source_check" CHECK ("source" IN ('sign-up', 'account', 'unsubscribe-link'));

-- Grants. The current consent is inserted and changed (granted, source, time), never removed by
-- the API; each change is appended to the history, which is never changed or removed.
GRANT USAGE ON SCHEMA "legal" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("granted", "source", "changed_at") ON TABLE "legal"."marketing_consents" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "legal"."marketing_consent_changes" TO "mondapac_app";
