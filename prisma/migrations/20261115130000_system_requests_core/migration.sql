-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "system_requests";

-- CreateTable
CREATE TABLE "system_requests"."requests" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "area" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "subject_ref" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "requested_by_account_id" UUID NOT NULL,
    "applied_at" TIMESTAMPTZ(6) NOT NULL,
    "review_due_at" TIMESTAMPTZ(6) NOT NULL,
    "decision" TEXT,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_reason" TEXT,
    "superseded_by_request_id" UUID,
    "comment_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_requests"."request_activity" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "actor_account_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "body" TEXT,

    CONSTRAINT "request_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_requests"."request_counters" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "request_counters_pkey" PRIMARY KEY ("market_id")
);

-- CreateTable
CREATE TABLE "system_requests"."policy_areas" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "default_risk" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_account_id" UUID NOT NULL,

    CONSTRAINT "policy_areas_pkey" PRIMARY KEY ("market_id","area")
);

-- CreateTable
CREATE TABLE "system_requests"."policy_settings" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "review_due_days" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_account_id" UUID NOT NULL,

    CONSTRAINT "policy_settings_pkey" PRIMARY KEY ("market_id")
);

-- CreateIndex
CREATE INDEX "requests_market_id_status_area_applied_at_idx" ON "system_requests"."requests"("market_id", "status", "area", "applied_at");

-- CreateIndex
CREATE INDEX "requests_market_id_subject_kind_subject_ref_applied_at_idx" ON "system_requests"."requests"("market_id", "subject_kind", "subject_ref", "applied_at");

-- CreateIndex
CREATE INDEX "requests_market_id_requested_by_account_id_applied_at_idx" ON "system_requests"."requests"("market_id", "requested_by_account_id", "applied_at");

-- CreateIndex
CREATE INDEX "requests_market_id_applied_at_number_idx" ON "system_requests"."requests"("market_id", "applied_at", "number");

-- CreateIndex
CREATE INDEX "requests_market_id_review_due_at_number_idx" ON "system_requests"."requests"("market_id", "review_due_at", "number");

-- CreateIndex
CREATE UNIQUE INDEX "requests_market_id_id_key" ON "system_requests"."requests"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "requests_market_id_number_key" ON "system_requests"."requests"("market_id", "number");

-- CreateIndex
CREATE INDEX "request_activity_market_id_request_id_at_idx" ON "system_requests"."request_activity"("market_id", "request_id", "at");

-- AddForeignKey
ALTER TABLE "system_requests"."request_activity" ADD CONSTRAINT "request_activity_market_id_request_id_fkey" FOREIGN KEY ("market_id", "request_id") REFERENCES "system_requests"."requests"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: value checks.
ALTER TABLE "system_requests"."requests"
  ADD CONSTRAINT "requests_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "requests_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "requests_number_check" CHECK ("number" >= 1),
  ADD CONSTRAINT "requests_area_check" CHECK ("area" IN ('people', 'money', 'delivery', 'catalogue', 'certification', 'marketplace', 'content', 'review-policy')),
  ADD CONSTRAINT "requests_subject_kind_check" CHECK ("subject_kind" ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$' AND char_length("subject_kind") <= 96),
  ADD CONSTRAINT "requests_subject_ref_check" CHECK ("subject_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND char_length("subject_ref") <= 128),
  ADD CONSTRAINT "requests_risk_check" CHECK ("risk" IN ('low', 'medium', 'high')),
  ADD CONSTRAINT "requests_status_check" CHECK ("status" IN ('open', 'approved', 'reverted')),
  ADD CONSTRAINT "requests_before_check" CHECK (jsonb_typeof("before") = 'object' AND octet_length("before"::text) <= 16384),
  ADD CONSTRAINT "requests_after_check" CHECK (jsonb_typeof("after") = 'object' AND octet_length("after"::text) <= 16384),
  ADD CONSTRAINT "requests_note_check" CHECK (char_length("note") BETWEEN 1 AND 500),
  ADD CONSTRAINT "requests_due_check" CHECK ("review_due_at" > "applied_at"),
  ADD CONSTRAINT "requests_comment_count_check" CHECK ("comment_count" >= 0),
  ADD CONSTRAINT "requests_decision_check" CHECK (
    ("status" = 'open' AND "decision" IS NULL AND "decided_by_account_id" IS NULL AND "decided_at" IS NULL AND "decision_reason" IS NULL)
    OR ("status" = 'approved' AND "decision" = 'approved' AND "decided_by_account_id" IS NOT NULL AND "decided_at" IS NOT NULL AND "decision_reason" IS NULL)
    OR ("status" = 'reverted' AND "decision" IN ('rejected', 'withdrawn') AND "decided_by_account_id" IS NOT NULL AND "decided_at" IS NOT NULL
        AND char_length("decision_reason") BETWEEN 1 AND 500)
  ),
  -- Maker-checker in the table too: only the author withdraws, and nobody approves or rejects their own change.
  ADD CONSTRAINT "requests_checker_check" CHECK (
    "decision" IS NULL
    OR ("decision" = 'withdrawn' AND "decided_by_account_id" = "requested_by_account_id")
    OR ("decision" IN ('approved', 'rejected') AND "decided_by_account_id" <> "requested_by_account_id")
  ),
  ADD CONSTRAINT "requests_superseded_check" CHECK ("superseded_by_request_id" IS NULL OR "superseded_by_request_id" <> "id");

ALTER TABLE "system_requests"."request_activity"
  ADD CONSTRAINT "request_activity_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "request_activity_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "request_activity_kind_check" CHECK ("kind" IN ('applied', 'commented', 'approved', 'rejected', 'withdrawn')),
  ADD CONSTRAINT "request_activity_body_check" CHECK (
    ("kind" IN ('applied', 'approved') AND "body" IS NULL)
    OR ("kind" IN ('commented', 'rejected', 'withdrawn') AND char_length("body") BETWEEN 1 AND 2000)
  );

ALTER TABLE "system_requests"."request_counters"
  ADD CONSTRAINT "request_counters_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "request_counters_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "request_counters_last_number_check" CHECK ("last_number" >= 0);

ALTER TABLE "system_requests"."policy_areas"
  ADD CONSTRAINT "policy_areas_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "policy_areas_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "policy_areas_area_check" CHECK ("area" IN ('people', 'money', 'delivery', 'catalogue', 'certification', 'marketplace', 'content')),
  ADD CONSTRAINT "policy_areas_default_risk_check" CHECK ("default_risk" IN ('low', 'medium', 'high')),
  ADD CONSTRAINT "policy_areas_version_check" CHECK ("version" >= 1);

ALTER TABLE "system_requests"."policy_settings"
  ADD CONSTRAINT "policy_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "policy_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "policy_settings_review_due_days_check" CHECK ("review_due_days" BETWEEN 1 AND 90),
  ADD CONSTRAINT "policy_settings_version_check" CHECK ("version" >= 1);

-- Hand-written: the activity is insert-only, nothing is ever deleted, and a decided request keeps
-- its decision (only its superseded marker and comment count still change). Unqualified names
-- resolve through the pinned search_path; the guard names its own table in full.
CREATE FUNCTION "system_requests"."reject_mutation"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'system_requests.%: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE FUNCTION "system_requests"."guard_request_decision"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."status" <> 'open' AND (
       NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."decision" IS DISTINCT FROM OLD."decision"
       OR NEW."decided_by_account_id" IS DISTINCT FROM OLD."decided_by_account_id"
       OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
       OR NEW."decision_reason" IS DISTINCT FROM OLD."decision_reason") THEN
    RAISE EXCEPTION 'system_requests.requests: a decided request keeps its decision'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- A supersession is final, except that it is released when the request that superseded this
  -- one was reverted (rejected or withdrawn): the subject holds this request's value again.
  IF OLD."superseded_by_request_id" IS NOT NULL
     AND NEW."superseded_by_request_id" IS DISTINCT FROM OLD."superseded_by_request_id"
     AND NOT (
       NEW."superseded_by_request_id" IS NULL
       AND EXISTS (
         SELECT 1 FROM "system_requests"."requests" AS "newer"
         WHERE "newer"."market_id" = OLD."market_id"
           AND "newer"."id" = OLD."superseded_by_request_id"
           AND "newer"."status" = 'reverted')) THEN
    RAISE EXCEPTION 'system_requests.requests: a superseded request stays superseded'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "requests_guard_decision" BEFORE UPDATE ON "system_requests"."requests"
  FOR EACH ROW EXECUTE FUNCTION "system_requests"."guard_request_decision"();
CREATE TRIGGER "requests_no_delete" BEFORE DELETE ON "system_requests"."requests"
  FOR EACH ROW EXECUTE FUNCTION "system_requests"."reject_mutation"();
CREATE TRIGGER "requests_no_truncate" BEFORE TRUNCATE ON "system_requests"."requests"
  FOR EACH STATEMENT EXECUTE FUNCTION "system_requests"."reject_mutation"();
CREATE TRIGGER "request_activity_no_update" BEFORE UPDATE ON "system_requests"."request_activity"
  FOR EACH ROW EXECUTE FUNCTION "system_requests"."reject_mutation"();
CREATE TRIGGER "request_activity_no_delete" BEFORE DELETE ON "system_requests"."request_activity"
  FOR EACH ROW EXECUTE FUNCTION "system_requests"."reject_mutation"();
CREATE TRIGGER "request_activity_no_truncate" BEFORE TRUNCATE ON "system_requests"."request_activity"
  FOR EACH STATEMENT EXECUTE FUNCTION "system_requests"."reject_mutation"();
CREATE TRIGGER "request_counters_no_delete" BEFORE DELETE ON "system_requests"."request_counters"
  FOR EACH ROW EXECUTE FUNCTION "system_requests"."reject_mutation"();
CREATE TRIGGER "request_counters_no_truncate" BEFORE TRUNCATE ON "system_requests"."request_counters"
  FOR EACH STATEMENT EXECUTE FUNCTION "system_requests"."reject_mutation"();
CREATE TRIGGER "policy_areas_no_delete" BEFORE DELETE ON "system_requests"."policy_areas"
  FOR EACH ROW EXECUTE FUNCTION "system_requests"."reject_mutation"();
CREATE TRIGGER "policy_areas_no_truncate" BEFORE TRUNCATE ON "system_requests"."policy_areas"
  FOR EACH STATEMENT EXECUTE FUNCTION "system_requests"."reject_mutation"();
CREATE TRIGGER "policy_settings_no_delete" BEFORE DELETE ON "system_requests"."policy_settings"
  FOR EACH ROW EXECUTE FUNCTION "system_requests"."reject_mutation"();
CREATE TRIGGER "policy_settings_no_truncate" BEFORE TRUNCATE ON "system_requests"."policy_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION "system_requests"."reject_mutation"();

-- Grants. A request changes only its decision, its superseded marker and its comment count; the
-- activity is read and appended to only; a counter and a policy row change only their values.
-- Nothing is deleted.
GRANT USAGE ON SCHEMA "system_requests" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "decision", "decided_by_account_id", "decided_at", "decision_reason", "superseded_by_request_id", "comment_count") ON TABLE "system_requests"."requests" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "system_requests"."request_activity" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("last_number") ON TABLE "system_requests"."request_counters" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("enabled", "default_risk", "version", "updated_at", "updated_by_account_id") ON TABLE "system_requests"."policy_areas" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("review_due_days", "version", "updated_at", "updated_by_account_id") ON TABLE "system_requests"."policy_settings" TO "mondapac_app";
