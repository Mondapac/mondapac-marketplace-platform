-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
-- The stripe_events CHECK swap re-scans the inbox under its lock: bound how long that may take.
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "payments"."disputes" (
    "market_id" VARCHAR(8) NOT NULL,
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider_dispute_id" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_intent_ref" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence_due_by" TIMESTAMPTZ(6),
    "funds_withdrawn" BOOLEAN NOT NULL,
    "funds_withdrawn_at" TIMESTAMPTZ(6),
    "funds_reinstated" BOOLEAN NOT NULL,
    "funds_reinstated_at" TIMESTAMPTZ(6),
    "outcome" TEXT,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "last_read_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateTable
CREATE TABLE "payments"."outbox" (
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
CREATE UNIQUE INDEX "disputes_market_id_provider_dispute_id_key" ON "payments"."disputes"("market_id", "provider_dispute_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "payments"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- Hand-written: scope and value checks. No card data, evidence or buyer text has a column.
ALTER TABLE "payments"."disputes"
  ADD CONSTRAINT "disputes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "disputes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "disputes_provider_dispute_id_check" CHECK ("provider_dispute_id" ~ '^(dp|du)_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "disputes_payment_intent_ref_check" CHECK ("payment_intent_ref" ~ '^pi_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "disputes_amount_minor_check" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "disputes_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "disputes_status_check" CHECK ("status" IN ('warning_needs_response',
    'warning_under_review', 'warning_closed', 'needs_response', 'under_review', 'won', 'lost',
    'prevented')),
  ADD CONSTRAINT "disputes_reason_check" CHECK ("reason" IN ('bank_cannot_process',
    'check_returned', 'credit_not_processed', 'customer_initiated', 'debit_not_authorized',
    'duplicate', 'fraudulent', 'general', 'incorrect_account_details', 'insufficient_funds',
    'noncompliant', 'product_not_received', 'product_unacceptable', 'subscription_canceled',
    'unrecognized', 'other')),
  -- The outcome is the closed status of a chargeback, and only that.
  ADD CONSTRAINT "disputes_outcome_check" CHECK (
    ("status" IN ('won', 'lost') AND "outcome" IS NOT DISTINCT FROM "status")
    OR ("status" NOT IN ('won', 'lost') AND "outcome" IS NULL)),
  -- Each money flag has its instant; a reinstatement needs the withdrawal before it.
  ADD CONSTRAINT "disputes_funds_withdrawn_at_check" CHECK ("funds_withdrawn" = ("funds_withdrawn_at" IS NOT NULL)),
  ADD CONSTRAINT "disputes_funds_reinstated_at_check" CHECK ("funds_reinstated" = ("funds_reinstated_at" IS NOT NULL)),
  ADD CONSTRAINT "disputes_funds_reinstated_check" CHECK (NOT "funds_reinstated" OR "funds_withdrawn"),
  ADD CONSTRAINT "disputes_funds_reinstated_order_check" CHECK ("funds_reinstated_at" IS NULL OR "funds_reinstated_at" >= "funds_withdrawn_at"),
  ADD CONSTRAINT "disputes_version_check" CHECK ("version" >= 1);

ALTER TABLE "payments"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^payments\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

-- Hand-written: the relay's claim index.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx"
  ON "payments"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

-- The Stripe events inbox also keeps the dispute events (object is the dispute) and their outcomes.
ALTER TABLE "payments"."stripe_events"
  DROP CONSTRAINT "stripe_events_object_id_check",
  DROP CONSTRAINT "stripe_events_type_check",
  DROP CONSTRAINT "stripe_events_outcome_check",
  ADD CONSTRAINT "stripe_events_object_id_check" CHECK ("object_id" ~ '^(cs|acct|dp|du)_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "stripe_events_type_check" CHECK ("type" IN (
    'checkout.session.completed', 'checkout.session.expired',
    'checkout.session.async_payment_failed', 'account.updated', 'capability.updated',
    'account.external_account.created', 'account.external_account.updated',
    'account.external_account.deleted', 'charge.dispute.created', 'charge.dispute.updated',
    'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'charge.dispute.closed')),
  ADD CONSTRAINT "stripe_events_outcome_check" CHECK (
    ("processed_at" IS NULL AND "outcome" IS NULL)
    OR ("processed_at" IS NOT NULL AND "outcome" IN ('confirmed', 'already-confirmed', 'voided',
      'cancelled', 'ignored', 'rejected', 'failed', 'account-updated', 'dispute-recorded',
      'other-market')));

-- Hand-written: what Stripe recorded is never taken back. The ids, order, amount and currency never
-- change (the grants already leave them out for the application). The money flags and their instants only
-- move from unset to set, a closed outcome stays, a stored read is never replaced by an older one,
-- and each change raises the version by exactly one, whoever asks.
CREATE FUNCTION "payments"."disputes_guard_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."market_id" IS DISTINCT FROM OLD."market_id" OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."provider_dispute_id" IS DISTINCT FROM OLD."provider_dispute_id"
     OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
     OR NEW."payment_intent_ref" IS DISTINCT FROM OLD."payment_intent_ref"
     OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."opened_at" IS DISTINCT FROM OLD."opened_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'payments.disputes: what a dispute is about never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."funds_withdrawn" AND NOT NEW."funds_withdrawn")
     OR (OLD."funds_reinstated" AND NOT NEW."funds_reinstated")
     OR (OLD."funds_withdrawn_at" IS NOT NULL AND NEW."funds_withdrawn_at" IS DISTINCT FROM OLD."funds_withdrawn_at")
     OR (OLD."funds_reinstated_at" IS NOT NULL AND NEW."funds_reinstated_at" IS DISTINCT FROM OLD."funds_reinstated_at") THEN
    RAISE EXCEPTION 'payments.disputes: a recorded money move cannot be taken back'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."outcome" IS NOT NULL AND (NEW."outcome" IS DISTINCT FROM OLD."outcome" OR NEW."status" <> OLD."status") THEN
    RAISE EXCEPTION 'payments.disputes: a closed dispute cannot change its outcome'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."last_read_at" < OLD."last_read_at" THEN
    RAISE EXCEPTION 'payments.disputes: an older read cannot replace a newer one'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'payments.disputes: each change raises the version by one'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "disputes_guard_update" BEFORE UPDATE ON "payments"."disputes"
  FOR EACH ROW EXECUTE FUNCTION "payments"."disputes_guard_update"();

-- Grants. A dispute is inserted once; only its changing state is updated (never the ids, order,
-- amount, currency or opening instant). The outbox is written by the unit and marked published by
-- the relay. No row is deleted by the application.
GRANT SELECT, INSERT, UPDATE ("status", "reason", "evidence_due_by", "funds_withdrawn", "funds_withdrawn_at", "funds_reinstated", "funds_reinstated_at", "outcome", "updated_at", "last_read_at", "version") ON TABLE "payments"."disputes" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "payments"."outbox" TO "mondapac_app";
