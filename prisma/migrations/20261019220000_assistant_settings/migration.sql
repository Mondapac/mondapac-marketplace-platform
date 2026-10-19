-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "assistant";

-- CreateTable
CREATE TABLE "assistant"."settings" (
    "market_id" VARCHAR(8) NOT NULL,
    "version" INTEGER NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "audience" VARCHAR(16) NOT NULL,
    "audience_percent" SMALLINT,
    "scope" VARCHAR(32) NOT NULL,
    "model_tier" VARCHAR(16) NOT NULL,
    "users" VARCHAR(32) NOT NULL,
    "guest_message_limit" SMALLINT NOT NULL,
    "customer_message_limit" SMALLINT NOT NULL,
    "retention" VARCHAR(16) NOT NULL,
    "reply_language" VARCHAR(16) NOT NULL,
    "daily_spend_cap_usd_cents" INTEGER NOT NULL,
    "monthly_spend_cap_usd_cents" INTEGER NOT NULL,
    "support_handoff" VARCHAR(16) NOT NULL,
    "welcome_text" VARCHAR(200),
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "changed_by" UUID NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("market_id","version")
);

-- Hand-written: scope and value checks, the same bounds as the API.
ALTER TABLE "assistant"."settings"
  ADD CONSTRAINT "settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "settings_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "settings_audience_check" CHECK (
    ("audience" IN ('internal', 'all') AND "audience_percent" IS NULL)
    OR ("audience" = 'percent' AND "audience_percent" IS NOT NULL
        AND "audience_percent" BETWEEN 1 AND 100)
  ),
  ADD CONSTRAINT "settings_scope_check" CHECK ("scope" IN ('read-only', 'cart-suggestions')),
  ADD CONSTRAINT "settings_model_tier_check" CHECK ("model_tier" IN ('fast', 'balanced')),
  ADD CONSTRAINT "settings_users_check" CHECK ("users" IN ('guests-and-customers', 'customers-only')),
  ADD CONSTRAINT "settings_guest_message_limit_check" CHECK ("guest_message_limit" BETWEEN 5 AND 60),
  ADD CONSTRAINT "settings_customer_message_limit_check" CHECK ("customer_message_limit" BETWEEN 5 AND 120),
  ADD CONSTRAINT "settings_retention_check" CHECK ("retention" IN ('none', '30-days', '12-months')),
  ADD CONSTRAINT "settings_reply_language_check" CHECK ("reply_language" IN ('buyer', 'english')),
  ADD CONSTRAINT "settings_spend_caps_check" CHECK (
    "daily_spend_cap_usd_cents" BETWEEN 100 AND 100000
    AND "monthly_spend_cap_usd_cents" BETWEEN 100 AND 2000000
    AND "daily_spend_cap_usd_cents" <= "monthly_spend_cap_usd_cents"
  ),
  ADD CONSTRAINT "settings_support_handoff_check" CHECK ("support_handoff" IN ('email-link', 'in-panel-form')),
  ADD CONSTRAINT "settings_welcome_text_check" CHECK (
    "welcome_text" IS NULL
    OR ("welcome_text" = btrim("welcome_text") AND length("welcome_text") >= 1
        -- Controls, format characters except U+200C (Persian), separators and markup, as the API.
        AND "welcome_text" !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB<>]')
  );

-- Grants. Insert-only: a change is a new version, nothing is updated or deleted.
GRANT USAGE ON SCHEMA "assistant" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "assistant"."settings" TO "mondapac_app";
