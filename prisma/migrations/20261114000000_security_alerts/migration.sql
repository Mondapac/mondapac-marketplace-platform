-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "security";

-- CreateTable
CREATE TABLE "security"."alerts" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "rule" VARCHAR(64) NOT NULL,
    "severity" VARCHAR(2) NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "key_type" VARCHAR(16) NOT NULL,
    "key_value" VARCHAR(64) NOT NULL,
    "event_count" INTEGER NOT NULL,
    "first_event_at" TIMESTAMPTZ(6) NOT NULL,
    "last_event_at" TIMESTAMPTZ(6) NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "notify_step" INTEGER NOT NULL,
    "next_notify_at" TIMESTAMPTZ(6),
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,
    "resolution" VARCHAR(16),
    "resolution_note" VARCHAR(1000),
    "version" INTEGER NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security"."alert_deliveries" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "alert_id" UUID NOT NULL,
    "step" INTEGER NOT NULL,
    "recipient" VARCHAR(32) NOT NULL,
    "channel" VARCHAR(16) NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alert_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security"."digest_runs" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "period" VARCHAR(10) NOT NULL,
    "alerts" INTEGER NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "digest_runs_pkey" PRIMARY KEY ("market_id","kind","period")
);

-- CreateTable
CREATE TABLE "security"."evaluator_runs" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "finished_at" TIMESTAMPTZ(6) NOT NULL,
    "opened" INTEGER NOT NULL,

    CONSTRAINT "evaluator_runs_pkey" PRIMARY KEY ("market_id")
);

-- CreateIndex
CREATE INDEX "alerts_market_id_state_severity_opened_at_idx" ON "security"."alerts"("market_id", "state", "severity", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "alerts_market_id_next_notify_at_idx" ON "security"."alerts"("market_id", "next_notify_at");

-- CreateIndex
CREATE INDEX "alerts_market_id_rule_key_type_key_value_resolved_at_idx" ON "security"."alerts"("market_id", "rule", "key_type", "key_value", "resolved_at");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_market_id_id_key" ON "security"."alerts"("market_id", "id");

-- CreateIndex
CREATE INDEX "alert_deliveries_market_id_alert_id_at_idx" ON "security"."alert_deliveries"("market_id", "alert_id", "at");

-- AddForeignKey
ALTER TABLE "security"."alert_deliveries" ADD CONSTRAINT "alert_deliveries_market_id_alert_id_fkey" FOREIGN KEY ("market_id", "alert_id") REFERENCES "security"."alerts"("market_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written: value checks (docs/design/data/security.md 2).
ALTER TABLE "security"."alerts"
  ADD CONSTRAINT "alerts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "alerts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "alerts_rule_check" CHECK ("rule" ~ '^[a-z][a-z0-9-]{1,63}$'),
  ADD CONSTRAINT "alerts_severity_check" CHECK ("severity" IN ('s1', 's2', 's3', 's4')),
  ADD CONSTRAINT "alerts_state_check" CHECK ("state" IN ('open', 'acknowledged', 'resolved')),
  ADD CONSTRAINT "alerts_key_type_check" CHECK ("key_type" IN ('account', 'ip', 'market', 'event')),
  ADD CONSTRAINT "alerts_key_value_check" CHECK (char_length("key_value") BETWEEN 1 AND 64),
  ADD CONSTRAINT "alerts_event_count_check" CHECK ("event_count" >= 1),
  ADD CONSTRAINT "alerts_event_window_check" CHECK ("first_event_at" <= "last_event_at"),
  ADD CONSTRAINT "alerts_notify_step_check" CHECK ("notify_step" >= 0),
  ADD CONSTRAINT "alerts_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "alerts_resolution_check" CHECK ("resolution" IS NULL OR "resolution" IN ('contained', 'false-positive', 'duplicate', 'accepted-risk')),
  ADD CONSTRAINT "alerts_resolution_note_check" CHECK ("resolution_note" IS NULL OR char_length("resolution_note") BETWEEN 10 AND 1000),
  -- Each state carries exactly its own columns: an open alert has no acknowledgement or resolution,
  -- an acknowledged one no resolution, a resolved one its resolver, outcome and note, and only an
  -- open alert has a next delivery step.
  ADD CONSTRAINT "alerts_state_columns_check" CHECK (
    ("state" = 'open'
       AND "acknowledged_at" IS NULL AND "acknowledged_by" IS NULL
       AND "resolved_at" IS NULL AND "resolved_by" IS NULL
       AND "resolution" IS NULL AND "resolution_note" IS NULL)
    OR ("state" = 'acknowledged'
       AND "acknowledged_at" IS NOT NULL AND "acknowledged_by" IS NOT NULL
       AND "resolved_at" IS NULL AND "resolved_by" IS NULL
       AND "resolution" IS NULL AND "resolution_note" IS NULL
       AND "next_notify_at" IS NULL)
    OR ("state" = 'resolved'
       AND "resolved_at" IS NOT NULL AND "resolved_by" IS NOT NULL
       AND "resolution" IS NOT NULL AND "resolution_note" IS NOT NULL
       AND "next_notify_at" IS NULL
       AND ("acknowledged_at" IS NULL) = ("acknowledged_by" IS NULL))
  );

ALTER TABLE "security"."alert_deliveries"
  ADD CONSTRAINT "alert_deliveries_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "alert_deliveries_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "alert_deliveries_step_check" CHECK ("step" >= 1),
  ADD CONSTRAINT "alert_deliveries_recipient_check" CHECK ("recipient" ~ '^[a-z][a-z0-9-]{0,31}$'),
  ADD CONSTRAINT "alert_deliveries_channel_check" CHECK ("channel" IN ('email', 'sms', 'call', 'team-chat')),
  ADD CONSTRAINT "alert_deliveries_outcome_check" CHECK ("outcome" IN ('sent', 'failed', 'not-configured', 'no-contact'));

ALTER TABLE "security"."digest_runs"
  ADD CONSTRAINT "digest_runs_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "digest_runs_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "digest_runs_kind_check" CHECK ("kind" IN ('daily', 'weekly')),
  ADD CONSTRAINT "digest_runs_period_check" CHECK ("period" ~ '^[0-9]{4}-(W[0-9]{2}|[0-9]{2}-[0-9]{2})$'),
  ADD CONSTRAINT "digest_runs_alerts_check" CHECK ("alerts" >= 0),
  ADD CONSTRAINT "digest_runs_outcome_check" CHECK ("outcome" IN ('sent', 'failed', 'not-configured', 'no-contact'));

ALTER TABLE "security"."evaluator_runs"
  ADD CONSTRAINT "evaluator_runs_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "evaluator_runs_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "evaluator_runs_opened_check" CHECK ("opened" >= 0);

-- Hand-written: one live alert per rule and key. A match of a key with an open or acknowledged
-- alert updates it; two evaluator runs racing on a new key insert one row (the other conflicts).
CREATE UNIQUE INDEX "alerts_market_id_rule_key_type_key_value_live_key" ON "security"."alerts" ("market_id", "rule", "key_type", "key_value")
  WHERE "state" <> 'resolved';

-- Hand-written: alerts are never deleted and a resolved alert never changes; the delivery
-- timeline and the digest runs are insert-only (SOC fixed rule: security records are append-only).
CREATE FUNCTION "security"."reject_mutation"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'security.%: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE FUNCTION "security"."alerts_guard_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."state" = 'resolved' THEN
    RAISE EXCEPTION 'security.alerts: a resolved alert does not change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- The identity of an alert and what opened it never change.
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."market_id" IS DISTINCT FROM OLD."market_id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."rule" IS DISTINCT FROM OLD."rule"
     OR NEW."severity" IS DISTINCT FROM OLD."severity" OR NEW."key_type" IS DISTINCT FROM OLD."key_type"
     OR NEW."key_value" IS DISTINCT FROM OLD."key_value" OR NEW."opened_at" IS DISTINCT FROM OLD."opened_at"
     OR NEW."first_event_at" IS DISTINCT FROM OLD."first_event_at" THEN
    RAISE EXCEPTION 'security.alerts: the identity of an alert does not change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- States move forward only: open -> acknowledged -> resolved, or open -> resolved.
  IF OLD."state" = 'acknowledged' AND NEW."state" = 'open' THEN
    RAISE EXCEPTION 'security.alerts: an acknowledged alert does not reopen'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- What happened stays: an acknowledgement is never rewritten or cleared, and the counts,
  -- the last event and the delivery step never go back.
  IF OLD."acknowledged_at" IS NOT NULL AND (NEW."acknowledged_at" IS DISTINCT FROM OLD."acknowledged_at"
     OR NEW."acknowledged_by" IS DISTINCT FROM OLD."acknowledged_by") THEN
    RAISE EXCEPTION 'security.alerts: an acknowledgement does not change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."event_count" < OLD."event_count" OR NEW."last_event_at" < OLD."last_event_at"
     OR NEW."notify_step" < OLD."notify_step" THEN
    RAISE EXCEPTION 'security.alerts: counts, the last event and the step never go back'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'security.alerts: every change adds one to the version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "alerts_guard_update" BEFORE UPDATE ON "security"."alerts"
  FOR EACH ROW EXECUTE FUNCTION "security"."alerts_guard_update"();
CREATE TRIGGER "alerts_no_delete" BEFORE DELETE ON "security"."alerts"
  FOR EACH ROW EXECUTE FUNCTION "security"."reject_mutation"();
CREATE TRIGGER "alerts_no_truncate" BEFORE TRUNCATE ON "security"."alerts"
  FOR EACH STATEMENT EXECUTE FUNCTION "security"."reject_mutation"();
CREATE TRIGGER "alert_deliveries_no_update" BEFORE UPDATE ON "security"."alert_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "security"."reject_mutation"();
CREATE TRIGGER "alert_deliveries_no_delete" BEFORE DELETE ON "security"."alert_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "security"."reject_mutation"();
CREATE TRIGGER "alert_deliveries_no_truncate" BEFORE TRUNCATE ON "security"."alert_deliveries"
  FOR EACH STATEMENT EXECUTE FUNCTION "security"."reject_mutation"();
CREATE TRIGGER "digest_runs_no_update" BEFORE UPDATE ON "security"."digest_runs"
  FOR EACH ROW EXECUTE FUNCTION "security"."reject_mutation"();
CREATE TRIGGER "digest_runs_no_delete" BEFORE DELETE ON "security"."digest_runs"
  FOR EACH ROW EXECUTE FUNCTION "security"."reject_mutation"();
CREATE TRIGGER "digest_runs_no_truncate" BEFORE TRUNCATE ON "security"."digest_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION "security"."reject_mutation"();
CREATE TRIGGER "evaluator_runs_no_delete" BEFORE DELETE ON "security"."evaluator_runs"
  FOR EACH ROW EXECUTE FUNCTION "security"."reject_mutation"();
CREATE TRIGGER "evaluator_runs_no_truncate" BEFORE TRUNCATE ON "security"."evaluator_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION "security"."reject_mutation"();

-- Grants. An alert changes only its count, last event, delivery and state columns; the timeline
-- and the digest runs are read and appended to only; the evaluator run changes its two values.
-- Nothing is deleted.
GRANT USAGE ON SCHEMA "security" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("state", "event_count", "last_event_at", "notify_step", "next_notify_at", "acknowledged_at", "acknowledged_by", "resolved_at", "resolved_by", "resolution", "resolution_note", "version") ON TABLE "security"."alerts" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "security"."alert_deliveries" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "security"."digest_runs" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("finished_at", "opened") ON TABLE "security"."evaluator_runs" TO "mondapac_app";
