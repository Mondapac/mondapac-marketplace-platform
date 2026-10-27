-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Payout terms and holds (Phase 5 package 6b; docs/design/domain/commission-payouts.md 3.2, 3.5,
-- 4.4, 4.5; docs/design/data/commission-payouts.md 3.6, 3.8, simplified by the package brief).
-- Only new tables, so nothing here is NOT VALID and no index is built CONCURRENTLY.

-- CreateTable
CREATE TABLE "commission_payouts"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateTable
CREATE TABLE "commission_payouts"."payout_terms_overrides" (
    "market_id" VARCHAR(8) NOT NULL,
    "seller_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "schedule_weekdays" SMALLINT,
    "local_minute" SMALLINT,
    "hold_days_carrier" SMALLINT,
    "hold_days_seller_click" SMALLINT,
    "minimum_minor" BIGINT,
    "approval_mode" TEXT,
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "payout_terms_overrides_pkey" PRIMARY KEY ("market_id","seller_id")
);

-- CreateTable
CREATE TABLE "commission_payouts"."eligibility_anchors" (
    "market_id" VARCHAR(8) NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "delivered_at" TIMESTAMPTZ(6) NOT NULL,
    "anchor_source" TEXT NOT NULL,
    "hold_days_applied" SMALLINT NOT NULL,
    "eligible_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "eligibility_anchors_pkey" PRIMARY KEY ("market_id","seller_order_id")
);

-- CreateTable
CREATE TABLE "commission_payouts"."payout_holds" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "seller_order_id" UUID,
    "reason" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "source_ref" UUID NOT NULL,
    "placed_by" UUID,
    "placed_at" TIMESTAMPTZ(6) NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "released_by" UUID,
    "release_reason" TEXT,

    CONSTRAINT "payout_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "eligibility_anchors_market_id_seller_id_eligible_at_idx" ON "commission_payouts"."eligibility_anchors"("market_id", "seller_id", "eligible_at");

-- CreateIndex
CREATE UNIQUE INDEX "payout_holds_source_key" ON "commission_payouts"."payout_holds"("market_id", "reason", "source_ref");


-- ---------------------------------------------------------------------------------------------
-- Hand-written: scope and value checks
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "commission_payouts"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^commission-payouts\.[a-z0-9-]+$');

-- The hold bounds 7 and 60 are the code constants MIN_HOLD_DAYS and MAX_HOLD_DAYS (a test asserts
-- they agree). A null field falls back to the Market's value; at least one field is set.
ALTER TABLE "commission_payouts"."payout_terms_overrides"
  ADD CONSTRAINT "payout_terms_overrides_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "payout_terms_overrides_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "payout_terms_overrides_weekdays_check" CHECK (
    "schedule_weekdays" IS NULL OR "schedule_weekdays" BETWEEN 1 AND 127),
  ADD CONSTRAINT "payout_terms_overrides_local_minute_check" CHECK (
    "local_minute" IS NULL OR "local_minute" BETWEEN 0 AND 1439),
  ADD CONSTRAINT "payout_terms_overrides_hold_carrier_check" CHECK (
    "hold_days_carrier" IS NULL OR "hold_days_carrier" BETWEEN 7 AND 60),
  ADD CONSTRAINT "payout_terms_overrides_hold_seller_click_check" CHECK (
    "hold_days_seller_click" IS NULL OR "hold_days_seller_click" BETWEEN 7 AND 60),
  ADD CONSTRAINT "payout_terms_overrides_minimum_check" CHECK (
    "minimum_minor" IS NULL OR "minimum_minor" >= 1),
  ADD CONSTRAINT "payout_terms_overrides_approval_mode_check" CHECK (
    "approval_mode" IS NULL OR "approval_mode" IN ('AUTO', 'MANUAL')),
  ADD CONSTRAINT "payout_terms_overrides_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "payout_terms_overrides_any_field_check" CHECK (
    num_nonnulls("schedule_weekdays", "local_minute", "hold_days_carrier", "hold_days_seller_click",
      "minimum_minor", "approval_mode") >= 1);

-- eligible_at is delivered_at plus the frozen hold days, in exact 24-hour days (no session-zone
-- day arithmetic), so a stored anchor can never be later or earlier than its own frozen hold.
ALTER TABLE "commission_payouts"."eligibility_anchors"
  ADD CONSTRAINT "eligibility_anchors_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "eligibility_anchors_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "eligibility_anchors_source_check" CHECK ("anchor_source" IN ('carrier', 'seller-click')),
  ADD CONSTRAINT "eligibility_anchors_hold_days_check" CHECK ("hold_days_applied" BETWEEN 7 AND 60),
  ADD CONSTRAINT "eligibility_anchors_eligible_at_check" CHECK (
    "eligible_at" = "delivered_at" + ("hold_days_applied" * 24) * INTERVAL '1 hour');

ALTER TABLE "commission_payouts"."payout_holds"
  ADD CONSTRAINT "payout_holds_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "payout_holds_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "payout_holds_reason_check" CHECK (
    "reason" IN ('seller-suspended', 'refund-pending', 'dispute', 'admin-review', 'bank-change')),
  ADD CONSTRAINT "payout_holds_origin_check" CHECK ("origin" IN ('admin', 'system')),
  -- An admin hold names its admin; a system hold names none.
  ADD CONSTRAINT "payout_holds_placed_by_check" CHECK (("origin" = 'admin') = ("placed_by" IS NOT NULL)),
  -- An admin places only an admin-review or a bank-change hold; the other reasons are the system's.
  ADD CONSTRAINT "payout_holds_admin_reason_check" CHECK (
    "origin" = 'system' OR "reason" IN ('admin-review', 'bank-change')),
  -- A suspension is a hold on the whole seller, placed by the system.
  ADD CONSTRAINT "payout_holds_suspended_check" CHECK (
    "reason" <> 'seller-suspended' OR ("origin" = 'system' AND "seller_order_id" IS NULL)),
  ADD CONSTRAINT "payout_holds_release_reason_check" CHECK (
    "release_reason" IS NULL OR "release_reason" IN
      ('resolved', 'placed-in-error', 'seller-reinstated', 'review-complete')),
  -- Released = all three release columns set, except released_by, which a later system release of a
  -- refund-pending or dispute hold leaves null.
  ADD CONSTRAINT "payout_holds_release_check" CHECK (
    ("released_at" IS NULL) = ("release_reason" IS NULL)
    AND ("released_by" IS NULL OR "released_at" IS NOT NULL)
    AND ("released_at" IS NULL OR "released_at" >= "placed_at")),
  -- The system never releases a seller-suspended hold: only an admin does, whatever else happens.
  ADD CONSTRAINT "payout_holds_suspended_release_check" CHECK (
    "reason" <> 'seller-suspended' OR "released_at" IS NULL OR "released_by" IS NOT NULL);

-- The payout run's reads: the active holds of a seller, and of one of its seller orders.
CREATE INDEX "payout_holds_active_seller_idx"
  ON "commission_payouts"."payout_holds" ("market_id", "seller_id") WHERE "released_at" IS NULL;
CREATE INDEX "payout_holds_active_seller_order_idx"
  ON "commission_payouts"."payout_holds" ("market_id", "seller_order_id")
  WHERE "released_at" IS NULL AND "seller_order_id" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Hand-written: write-once guards
-- ---------------------------------------------------------------------------------------------

-- An anchor is set once: the insert-only trigger function of the ledger refuses UPDATE, DELETE
-- and TRUNCATE.
CREATE TRIGGER "eligibility_anchors_no_update" BEFORE UPDATE ON "commission_payouts"."eligibility_anchors"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."reject_mutation"();
CREATE TRIGGER "eligibility_anchors_no_delete" BEFORE DELETE ON "commission_payouts"."eligibility_anchors"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."reject_mutation"();
CREATE TRIGGER "eligibility_anchors_no_truncate" BEFORE TRUNCATE ON "commission_payouts"."eligibility_anchors"
  FOR EACH STATEMENT EXECUTE FUNCTION "commission_payouts"."reject_mutation"();

-- A hold is inserted and released, nothing else: the only UPDATE that passes sets the three release
-- columns of an active hold, once. Everything else, a second release included, is refused.
CREATE FUNCTION "commission_payouts"."payout_holds_guard_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."released_at" IS NOT NULL THEN
    RAISE EXCEPTION 'commission_payouts.payout_holds: a released hold never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."released_at" IS NULL THEN
    RAISE EXCEPTION 'commission_payouts.payout_holds: only a release may update a hold'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'released_at' - 'released_by' - 'release_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'released_at' - 'released_by' - 'release_reason') THEN
    RAISE EXCEPTION 'commission_payouts.payout_holds: only the release columns may change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "payout_holds_guard_update" BEFORE UPDATE ON "commission_payouts"."payout_holds"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."payout_holds_guard_update"();
CREATE TRIGGER "payout_holds_no_delete" BEFORE DELETE ON "commission_payouts"."payout_holds"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."reject_mutation"();
CREATE TRIGGER "payout_holds_no_truncate" BEFORE TRUNCATE ON "commission_payouts"."payout_holds"
  FOR EACH STATEMENT EXECUTE FUNCTION "commission_payouts"."reject_mutation"();

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------

-- The inbox is read and appended to. A terms override is inserted, changed (its value columns and
-- version) and removed (back to the Market's terms). An anchor is read and appended to. A hold is
-- read, inserted and released (three columns).
GRANT SELECT, INSERT ON TABLE "commission_payouts"."inbox" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE,
  UPDATE ("schedule_weekdays", "local_minute", "hold_days_carrier", "hold_days_seller_click",
    "minimum_minor", "approval_mode", "version", "updated_at", "updated_by")
  ON TABLE "commission_payouts"."payout_terms_overrides" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "commission_payouts"."eligibility_anchors" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("released_at", "released_by", "release_reason")
  ON TABLE "commission_payouts"."payout_holds" TO "mondapac_app";
