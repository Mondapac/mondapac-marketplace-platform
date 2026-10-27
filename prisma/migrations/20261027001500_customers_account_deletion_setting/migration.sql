-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable: the Market's buyer account deletion setting, one row per version.
CREATE TABLE "customers"."account_deletion_settings" (
    "market_id" VARCHAR(8) NOT NULL,
    "version" INTEGER NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "waiting_period_days" SMALLINT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "changed_by" UUID NOT NULL,

    CONSTRAINT "account_deletion_settings_pkey" PRIMARY KEY ("market_id","version")
);

-- CreateTable: customers publishes `customers.account-deletion-settings-changed.v1`.
CREATE TABLE "customers"."outbox" (
    "event_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" UUID,
    "payload" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "customers"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- Hand-written: scope and value checks, the same bounds as the API.
ALTER TABLE "customers"."account_deletion_settings"
  ADD CONSTRAINT "account_deletion_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "account_deletion_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "account_deletion_settings_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "account_deletion_settings_waiting_period_days_check" CHECK ("waiting_period_days" BETWEEN 7 AND 90),
  ADD CONSTRAINT "account_deletion_settings_reason_check" CHECK (
    "reason" = btrim("reason") AND length("reason") >= 1
    -- Controls, format characters (Unicode Cf, tag characters included) except U+200C (Persian),
    -- separators and markup, as the API.
    AND "reason" !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB\\U000110BD\\U000110CD\\U00013430-\\U0001343F\\U0001BCA0-\\U0001BCA3\\U0001D173-\\U0001D17A\\U000E0001\\U000E0020-\\U000E007F<>]'
  );

ALTER TABLE "customers"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^customers\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

-- Hand-written: the relay's claim index.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx"
  ON "customers"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

-- Grants. The setting history is insert-only: a change is a new version, nothing is updated or
-- deleted. The outbox is written by the unit and marked published by the relay.
GRANT SELECT, INSERT ON TABLE "customers"."account_deletion_settings" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "customers"."outbox" TO "mondapac_app";
