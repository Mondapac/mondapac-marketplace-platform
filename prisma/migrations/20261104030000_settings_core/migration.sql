-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "settings";

-- CreateTable
CREATE TABLE "settings"."market_settings" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_account_id" UUID NOT NULL,

    CONSTRAINT "market_settings_pkey" PRIMARY KEY ("market_id","code")
);

-- CreateTable
CREATE TABLE "settings"."market_setting_history" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "previous_value" TEXT,
    "value" TEXT NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "changed_by_account_id" UUID NOT NULL,

    CONSTRAINT "market_setting_history_pkey" PRIMARY KEY ("market_id","code","version")
);

-- Hand-written: value checks.
ALTER TABLE "settings"."market_settings"
  ADD CONSTRAINT "market_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "market_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "market_settings_code_check" CHECK ("code" ~ '^[a-z][a-z0-9-]{1,63}$'),
  ADD CONSTRAINT "market_settings_value_check" CHECK (char_length("value") BETWEEN 1 AND 64),
  ADD CONSTRAINT "market_settings_version_check" CHECK ("version" >= 1);

ALTER TABLE "settings"."market_setting_history"
  ADD CONSTRAINT "market_setting_history_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "market_setting_history_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "market_setting_history_code_check" CHECK ("code" ~ '^[a-z][a-z0-9-]{1,63}$'),
  ADD CONSTRAINT "market_setting_history_value_check" CHECK (char_length("value") BETWEEN 1 AND 64),
  ADD CONSTRAINT "market_setting_history_previous_value_check" CHECK ("previous_value" IS NULL OR char_length("previous_value") BETWEEN 1 AND 64),
  ADD CONSTRAINT "market_setting_history_version_check" CHECK ("version" >= 1);

-- Hand-written: the history is insert-only and no setting is ever deleted (ADR-0026 decision 4).
CREATE FUNCTION "settings"."reject_mutation"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'settings.%: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE TRIGGER "market_setting_history_no_update" BEFORE UPDATE ON "settings"."market_setting_history"
  FOR EACH ROW EXECUTE FUNCTION "settings"."reject_mutation"();
CREATE TRIGGER "market_setting_history_no_delete" BEFORE DELETE ON "settings"."market_setting_history"
  FOR EACH ROW EXECUTE FUNCTION "settings"."reject_mutation"();
CREATE TRIGGER "market_setting_history_no_truncate" BEFORE TRUNCATE ON "settings"."market_setting_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "settings"."reject_mutation"();
CREATE TRIGGER "market_settings_no_delete" BEFORE DELETE ON "settings"."market_settings"
  FOR EACH ROW EXECUTE FUNCTION "settings"."reject_mutation"();
CREATE TRIGGER "market_settings_no_truncate" BEFORE TRUNCATE ON "settings"."market_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION "settings"."reject_mutation"();

-- Grants. A setting changes only the columns named (its identity never changes); the history is
-- read and appended to only. Nothing is deleted.
GRANT USAGE ON SCHEMA "settings" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("value", "version", "updated_at", "updated_by_account_id") ON TABLE "settings"."market_settings" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "settings"."market_setting_history" TO "mondapac_app";
