-- Risk-based Offer approval, slice 2c (ADR-0051): edits of a live Offer that the review policy
-- sends to the queue. A new, empty table; no backfill. offer_review_referrals gains the `edit`
-- trigger and a link to the pending change.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TABLE "catalog"."offer_pending_changes" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "base_offer_version" INTEGER NOT NULL,
    "proposed_description" JSONB,
    "proposed_handling" TEXT,
    "proposed_tag_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "reasons" TEXT[] NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "superseded_cause" TEXT,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "submitted_by_account_id" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_account_id" UUID,
    "decision_note" TEXT,

    CONSTRAINT "offer_pending_changes_pkey" PRIMARY KEY ("id")
);

-- Target of the referral foreign key (same Offer).
CREATE UNIQUE INDEX "offer_pending_changes_market_id_id_offer_id_key"
  ON "catalog"."offer_pending_changes"("market_id", "id", "offer_id");
-- Admin queue: WHERE market_id = $1 AND status = 'pending' ORDER BY submitted_at, id (keyset).
CREATE INDEX "offer_pending_changes_market_id_status_submitted_at_id_idx"
  ON "catalog"."offer_pending_changes"("market_id", "status", "submitted_at", "id");
-- Per-Offer read (seller's latest change, decision note): ORDER BY submitted_at DESC LIMIT 1.
CREATE INDEX "offer_pending_changes_market_id_offer_id_submitted_at_idx"
  ON "catalog"."offer_pending_changes"("market_id", "offer_id", "submitted_at");

ALTER TABLE "catalog"."offer_pending_changes" ADD CONSTRAINT "offer_pending_changes_market_id_offer_id_seller_id_fkey"
  FOREIGN KEY ("market_id", "offer_id", "seller_id") REFERENCES "catalog"."offers"("market_id", "id", "seller_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): CHECKs, the open-change partial unique, the guard and grants.
ALTER TABLE "catalog"."offer_pending_changes"
  ADD CONSTRAINT "offer_pending_changes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_pending_changes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_pending_changes_base_offer_version_check" CHECK ("base_offer_version" >= 1),
  ADD CONSTRAINT "offer_pending_changes_policy_version_check" CHECK ("policy_version" >= 1),
  ADD CONSTRAINT "offer_pending_changes_proposed_description_check" CHECK (
    "proposed_description" IS NULL OR jsonb_typeof("proposed_description") = 'object'),
  ADD CONSTRAINT "offer_pending_changes_proposed_handling_check" CHECK (
    "proposed_handling" IS NULL OR "proposed_handling" IN ('SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH')),
  -- Type codes as offer_tags.type_code; a code holds no comma, so the joined string is checked.
  ADD CONSTRAINT "offer_pending_changes_proposed_tag_types_check" CHECK (
    array_position("proposed_tag_types", NULL) IS NULL
    AND cardinality("proposed_tag_types") <= 32
    AND array_to_string("proposed_tag_types", ',') ~ '^([a-z][a-z0-9_-]{0,63}(,|$))*$'),
  ADD CONSTRAINT "offer_pending_changes_proposed_check" CHECK (
    "proposed_description" IS NOT NULL OR "proposed_handling" IS NOT NULL
    OR cardinality("proposed_tag_types") > 0),
  ADD CONSTRAINT "offer_pending_changes_reasons_check" CHECK (
    array_position("reasons", NULL) IS NULL
    AND cardinality("reasons") BETWEEN 1 AND 4
    AND "reasons" <@ ARRAY['certificate-badge', 'handling', 'contact-text', 'review-all']::text[]),
  ADD CONSTRAINT "offer_pending_changes_status_check" CHECK ("status" IN
    ('pending', 'approved', 'changes-requested', 'rejected', 'withdrawn', 'superseded')),
  ADD CONSTRAINT "offer_pending_changes_superseded_cause_check" CHECK (
    ("status" = 'superseded') = ("superseded_cause" IS NOT NULL)
    AND ("superseded_cause" IS NULL OR "superseded_cause" IN ('resubmitted', 'offer-deleted'))),
  -- pending: nothing decided. Admin decisions and a withdrawal name the account; supersede is the system.
  ADD CONSTRAINT "offer_pending_changes_decided_check" CHECK (
    CASE "status"
      WHEN 'pending' THEN "decided_at" IS NULL AND "decided_by_account_id" IS NULL AND "decision_note" IS NULL
      WHEN 'superseded' THEN "decided_at" IS NOT NULL AND "decided_by_account_id" IS NULL AND "decision_note" IS NULL
      WHEN 'withdrawn' THEN "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL AND "decision_note" IS NULL
      ELSE "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL
    END),
  ADD CONSTRAINT "offer_pending_changes_decided_at_check" CHECK ("decided_at" IS NULL OR "decided_at" >= "submitted_at"),
  ADD CONSTRAINT "offer_pending_changes_decision_note_check" CHECK (
    "decision_note" IS NULL OR char_length("decision_note") BETWEEN 1 AND 2000);

-- At most one open change per Offer.
CREATE UNIQUE INDEX "offer_pending_changes_open_offer_key"
  ON "catalog"."offer_pending_changes"("market_id", "offer_id") WHERE "status" = 'pending';

-- Born pending; decided once (pending -> one terminal status); only the decision columns move;
-- never deleted. Data design 5.1 rules (SECURITY INVOKER, pinned path).
CREATE FUNCTION "catalog"."offer_pending_changes_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.offer_pending_changes: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'catalog.offer_pending_changes: a new change is pending' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.submitted_at > statement_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'catalog.offer_pending_changes: submitted_at is in the future' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.market_id, NEW.tenant_id, NEW.offer_id, NEW.seller_id, NEW.base_offer_version,
      NEW.proposed_description, NEW.proposed_handling, NEW.proposed_tag_types, NEW.reasons,
      NEW.policy_version, NEW.submitted_at, NEW.submitted_by_account_id)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.tenant_id, OLD.offer_id, OLD.seller_id, OLD.base_offer_version,
      OLD.proposed_description, OLD.proposed_handling, OLD.proposed_tag_types, OLD.reasons,
      OLD.policy_version, OLD.submitted_at, OLD.submitted_by_account_id) THEN
    RAISE EXCEPTION 'catalog.offer_pending_changes: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status = 'pending' THEN
    RAISE EXCEPTION 'catalog.offer_pending_changes: only a pending change is decided, once' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.decided_at < statement_timestamp() - interval '5 minutes'
     OR NEW.decided_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'catalog.offer_pending_changes: decided_at outside tolerance' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "offer_pending_changes_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "catalog"."offer_pending_changes"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."offer_pending_changes_guard"();
CREATE TRIGGER "offer_pending_changes_no_truncate" BEFORE TRUNCATE
  ON "catalog"."offer_pending_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

GRANT SELECT, INSERT ON TABLE "catalog"."offer_pending_changes" TO "mondapac_app";
GRANT UPDATE ("status", "superseded_cause", "decided_at", "decided_by_account_id", "decision_note")
  ON TABLE "catalog"."offer_pending_changes" TO "mondapac_app";

-- offer_review_referrals: the edit trigger and its pending change (a small table: the re-validated
-- CHECK and the empty-column FK validation are short locks).
ALTER TABLE "catalog"."offer_review_referrals" ADD COLUMN "pending_change_id" UUID;
ALTER TABLE "catalog"."offer_review_referrals" DROP CONSTRAINT "offer_review_referrals_trigger_check";
ALTER TABLE "catalog"."offer_review_referrals"
  ADD CONSTRAINT "offer_review_referrals_trigger_check" CHECK ("trigger" IN ('first-publication', 'edit')),
  -- Only an edit names a change, and a named change was sent to the queue (reasons not empty).
  ADD CONSTRAINT "offer_review_referrals_pending_change_check" CHECK (
    "pending_change_id" IS NULL
    OR ("trigger" = 'edit' AND cardinality("reasons") >= 1));
ALTER TABLE "catalog"."offer_review_referrals" ADD CONSTRAINT "offer_review_referrals_pending_change_fkey"
  FOREIGN KEY ("market_id", "pending_change_id", "offer_id")
  REFERENCES "catalog"."offer_pending_changes"("market_id", "id", "offer_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- One decision per pending change.
CREATE UNIQUE INDEX "offer_review_referrals_pending_change_id_key"
  ON "catalog"."offer_review_referrals"("market_id", "pending_change_id") WHERE "pending_change_id" IS NOT NULL;
