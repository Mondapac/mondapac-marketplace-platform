-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Dispute effects (Phase 5 package 8b; docs/design/domain/commission-payouts.md 4.10): the case
-- snapshot, the admin's per-seller-order decision, and commission-payouts' own outbox for
-- `commission-payouts.seller-order-disputed.v1`. Only new tables, so nothing here is NOT VALID and
-- no index is built CONCURRENTLY.

-- CreateTable
CREATE TABLE "commission_payouts"."dispute_cases" (
    "market_id" VARCHAR(8) NOT NULL,
    "dispute_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "provider_dispute_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "inquiry" BOOLEAN NOT NULL,
    "closed" BOOLEAN NOT NULL,
    "outcome" TEXT,
    "reason" TEXT NOT NULL,
    "evidence_due_by" TIMESTAMPTZ(6),
    "funds_withdrawn" BOOLEAN NOT NULL,
    "funds_withdrawn_at" TIMESTAMPTZ(6),
    "funds_reinstated" BOOLEAN NOT NULL,
    "funds_reinstated_at" TIMESTAMPTZ(6),
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),
    "bucket" TEXT NOT NULL,
    "last_synced_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dispute_cases_pkey" PRIMARY KEY ("market_id","dispute_id")
);

-- CreateTable
CREATE TABLE "commission_payouts"."dispute_decisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "dispute_id" UUID NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "bearer" TEXT NOT NULL,
    "amount_minor" BIGINT,
    "currency" CHAR(3),
    "reason_code" TEXT NOT NULL,
    "decided_by" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL,
    "supersedes" UUID,

    CONSTRAINT "dispute_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_payouts"."outbox" (
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
CREATE INDEX "dispute_cases_bucket_idx" ON "commission_payouts"."dispute_cases"("market_id", "bucket", "opened_at" DESC, "dispute_id" DESC);

-- CreateIndex
CREATE INDEX "dispute_decisions_market_id_dispute_id_idx" ON "commission_payouts"."dispute_decisions"("market_id", "dispute_id");

-- CreateIndex
CREATE INDEX "dispute_decisions_market_id_seller_id_idx" ON "commission_payouts"."dispute_decisions"("market_id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "commission_payouts"."outbox"("market_id", "aggregate_id", "aggregate_version");

-- ---------------------------------------------------------------------------------------------
-- Hand-written: scope and value checks
-- ---------------------------------------------------------------------------------------------

-- No card, buyer text or evidence has a column. Money is minor units plus a currency.
ALTER TABLE "commission_payouts"."dispute_cases"
  ADD CONSTRAINT "dispute_cases_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "dispute_cases_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "dispute_cases_provider_dispute_id_check" CHECK ("provider_dispute_id" ~ '^(dp|du)_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "dispute_cases_amount_check" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "dispute_cases_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "dispute_cases_status_check" CHECK ("status" IN ('warning_needs_response',
    'warning_under_review', 'warning_closed', 'needs_response', 'under_review', 'won', 'lost',
    'prevented')),
  ADD CONSTRAINT "dispute_cases_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('won', 'lost')),
  -- An outcome exists only on a closed case.
  ADD CONSTRAINT "dispute_cases_outcome_closed_check" CHECK ("outcome" IS NULL OR "closed"),
  ADD CONSTRAINT "dispute_cases_reason_check" CHECK ("reason" ~ '^[a-z_]{1,64}$'),
  ADD CONSTRAINT "dispute_cases_funds_withdrawn_at_check" CHECK ("funds_withdrawn" = ("funds_withdrawn_at" IS NOT NULL)),
  ADD CONSTRAINT "dispute_cases_funds_reinstated_at_check" CHECK ("funds_reinstated" = ("funds_reinstated_at" IS NOT NULL)),
  ADD CONSTRAINT "dispute_cases_funds_reinstated_check" CHECK (NOT "funds_reinstated" OR "funds_withdrawn"),
  ADD CONSTRAINT "dispute_cases_closed_at_check" CHECK ("closed" = ("closed_at" IS NOT NULL)),
  ADD CONSTRAINT "dispute_cases_bucket_check" CHECK ("bucket" IN ('needs-response', 'under-review',
    'decision-needed', 'won', 'closed')),
  ADD CONSTRAINT "dispute_cases_version_check" CHECK ("last_synced_version" >= 1),
  ADD CONSTRAINT "dispute_cases_updated_at_check" CHECK ("updated_at" >= "created_at");

ALTER TABLE "commission_payouts"."dispute_decisions"
  ADD CONSTRAINT "dispute_decisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "dispute_decisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "dispute_decisions_bearer_check" CHECK ("bearer" IN ('platform', 'seller')),
  -- The seller repays a positive amount; the platform bears it with no amount.
  -- (Each side is written so that a NULL cannot make the whole CHECK unknown, which passes.)
  ADD CONSTRAINT "dispute_decisions_amount_check" CHECK (
    ("bearer" = 'seller' AND "amount_minor" IS NOT NULL AND "amount_minor" > 0
      AND "currency" IS NOT NULL AND "currency" ~ '^[A-Z]{3}$')
    OR ("bearer" = 'platform' AND "amount_minor" IS NULL AND "currency" IS NULL)),
  ADD CONSTRAINT "dispute_decisions_reason_code_check" CHECK ("reason_code" IN
    ('no-delivery-proof', 'not-as-described', 'card-fraud-not-seller', 'other')),
  -- Only the platform reverses a seller decision (seller to platform), never the other way.
  ADD CONSTRAINT "dispute_decisions_supersedes_check" CHECK ("supersedes" IS NULL OR "bearer" = 'platform');

-- A reversal names a decision of the same dispute and seller order (a composite self-reference; a
-- first decision has no `supersedes`, and MATCH SIMPLE skips the check for NULL).
ALTER TABLE "commission_payouts"."dispute_decisions"
  ADD CONSTRAINT "dispute_decisions_scope_id_key"
    UNIQUE ("market_id", "dispute_id", "seller_order_id", "id"),
  ADD CONSTRAINT "dispute_decisions_supersedes_fkey"
    FOREIGN KEY ("market_id", "dispute_id", "seller_order_id", "supersedes")
    REFERENCES "commission_payouts"."dispute_decisions" ("market_id", "dispute_id", "seller_order_id", "id");

-- What a reversal reverses is a seller decision (the CHECK above holds the reversal's own side).
CREATE FUNCTION "commission_payouts"."dispute_decisions_check_supersedes"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."supersedes" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "commission_payouts"."dispute_decisions" d
     WHERE d."id" = NEW."supersedes" AND d."bearer" = 'seller') THEN
    RAISE EXCEPTION 'commission_payouts.dispute_decisions: only a seller decision is reversed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "dispute_decisions_check_supersedes" BEFORE INSERT ON "commission_payouts"."dispute_decisions"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."dispute_decisions_check_supersedes"();

-- One first decision per seller order and dispute; one reversal per decision.
CREATE UNIQUE INDEX "dispute_decisions_first_key"
  ON "commission_payouts"."dispute_decisions" ("market_id", "dispute_id", "seller_order_id")
  WHERE "supersedes" IS NULL;
CREATE UNIQUE INDEX "dispute_decisions_reversal_key"
  ON "commission_payouts"."dispute_decisions" ("market_id", "supersedes")
  WHERE "supersedes" IS NOT NULL;

ALTER TABLE "commission_payouts"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^commission-payouts\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

-- Hand-written: the relay's claim index.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx"
  ON "commission_payouts"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Hand-written: write guards
-- ---------------------------------------------------------------------------------------------

-- A decision is inserted, never changed or deleted: the insert-only trigger function of the ledger.
CREATE TRIGGER "dispute_decisions_no_update" BEFORE UPDATE ON "commission_payouts"."dispute_decisions"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."reject_mutation"();
CREATE TRIGGER "dispute_decisions_no_delete" BEFORE DELETE ON "commission_payouts"."dispute_decisions"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."reject_mutation"();
CREATE TRIGGER "dispute_decisions_no_truncate" BEFORE TRUNCATE ON "commission_payouts"."dispute_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "commission_payouts"."reject_mutation"();

-- A case snapshot moves one way, whoever asks: the identity columns never change, the money flags
-- and `closed` go from false to true only (with their instants kept), the outcome is set once and
-- the synced version never falls.
CREATE FUNCTION "commission_payouts"."dispute_cases_guard_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."dispute_id" <> OLD."dispute_id" OR NEW."market_id" <> OLD."market_id"
     OR NEW."tenant_id" <> OLD."tenant_id" OR NEW."order_id" <> OLD."order_id"
     OR NEW."provider_dispute_id" <> OLD."provider_dispute_id"
     OR NEW."amount_minor" <> OLD."amount_minor" OR NEW."currency" <> OLD."currency"
     OR NEW."opened_at" <> OLD."opened_at" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'commission_payouts.dispute_cases: the identity of a case never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."last_synced_version" < OLD."last_synced_version" THEN
    RAISE EXCEPTION 'commission_payouts.dispute_cases: an older read never replaces a newer one'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."funds_withdrawn" AND NOT NEW."funds_withdrawn")
     OR (OLD."funds_reinstated" AND NOT NEW."funds_reinstated")
     OR (OLD."closed" AND NOT NEW."closed") THEN
    RAISE EXCEPTION 'commission_payouts.dispute_cases: a flag only moves from false to true'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."funds_withdrawn_at" IS NOT NULL AND NEW."funds_withdrawn_at" IS DISTINCT FROM OLD."funds_withdrawn_at")
     OR (OLD."funds_reinstated_at" IS NOT NULL AND NEW."funds_reinstated_at" IS DISTINCT FROM OLD."funds_reinstated_at")
     OR (OLD."closed_at" IS NOT NULL AND NEW."closed_at" IS DISTINCT FROM OLD."closed_at") THEN
    RAISE EXCEPTION 'commission_payouts.dispute_cases: a recorded instant never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."outcome" IS NOT NULL AND NEW."outcome" IS DISTINCT FROM OLD."outcome" THEN
    RAISE EXCEPTION 'commission_payouts.dispute_cases: a closed outcome stays'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "dispute_cases_guard_update" BEFORE UPDATE ON "commission_payouts"."dispute_cases"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."dispute_cases_guard_update"();
CREATE TRIGGER "dispute_cases_no_delete" BEFORE DELETE ON "commission_payouts"."dispute_cases"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."reject_mutation"();
CREATE TRIGGER "dispute_cases_no_truncate" BEFORE TRUNCATE ON "commission_payouts"."dispute_cases"
  FOR EACH STATEMENT EXECUTE FUNCTION "commission_payouts"."reject_mutation"();

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------

-- A case is read, inserted and refreshed (state columns only). A decision is read and inserted.
-- The outbox is written by the unit and marked published by the relay.
GRANT SELECT, INSERT,
  UPDATE ("status", "inquiry", "closed", "outcome", "reason", "evidence_due_by", "funds_withdrawn",
    "funds_withdrawn_at", "funds_reinstated", "funds_reinstated_at", "closed_at", "bucket",
    "last_synced_version", "updated_at")
  ON TABLE "commission_payouts"."dispute_cases" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "commission_payouts"."dispute_decisions" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "commission_payouts"."outbox" TO "mondapac_app";
