-- Risk-based Offer approval, slice 6 (ADR-0051): the post-publication review list of published
-- Offers (catalog.offer_post_reviews) and the insert-only reasons each row received
-- (catalog.offer_post_review_reasons, the idempotency key of the referrals from pricing and of a
-- sample). New tables are empty; no backfill. A held edit may be superseded by a take-down
-- (`taken-down`); offer_pending_changes is small, so its CHECK is replaced valid in one short lock.
-- Lock order of the units: the Offer row first (the take-down and the submit both lock it before
-- anything else); after it the order of the rest does not matter, because the Offer lock
-- serializes them (the refer and the approve lock one post-review row only).
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- CreateTable
CREATE TABLE "catalog"."offer_post_reviews" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "reasons" TEXT[],
    "sample_percent" INTEGER,
    "sample_doubled" BOOLEAN NOT NULL DEFAULT false,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_account_id" UUID,
    "decision_reason_code" TEXT,
    "misconduct" BOOLEAN,
    "note" TEXT,
    "version" INTEGER NOT NULL,

    CONSTRAINT "offer_post_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."offer_post_review_reasons" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "post_review_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offer_post_review_reasons_pkey" PRIMARY KEY ("market_id","offer_id","reason","source_ref")
);

-- CreateIndex
CREATE INDEX "offer_post_reviews_market_id_status_opened_at_id_idx" ON "catalog"."offer_post_reviews"("market_id", "status", "opened_at", "id");

-- CreateIndex
CREATE INDEX "offer_post_reviews_market_id_opened_at_id_idx" ON "catalog"."offer_post_reviews"("market_id", "opened_at", "id");

-- CreateIndex
CREATE INDEX "offer_post_reviews_market_id_seller_id_opened_at_id_idx" ON "catalog"."offer_post_reviews"("market_id", "seller_id", "opened_at", "id");

-- CreateIndex
CREATE INDEX "offer_post_reviews_market_id_status_seller_id_idx" ON "catalog"."offer_post_reviews"("market_id", "status", "seller_id");

-- CreateIndex
CREATE INDEX "offer_post_reviews_market_id_offer_id_idx" ON "catalog"."offer_post_reviews"("market_id", "offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "offer_post_reviews_market_id_id_offer_id_key" ON "catalog"."offer_post_reviews"("market_id", "id", "offer_id");

-- CreateIndex
CREATE INDEX "offer_post_review_reasons_market_id_post_review_id_idx" ON "catalog"."offer_post_review_reasons"("market_id", "post_review_id");

-- AddForeignKey
ALTER TABLE "catalog"."offer_post_reviews" ADD CONSTRAINT "offer_post_reviews_market_id_offer_id_seller_id_fkey" FOREIGN KEY ("market_id", "offer_id", "seller_id") REFERENCES "catalog"."offers"("market_id", "id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."offer_post_reviews" ADD CONSTRAINT "offer_post_reviews_market_id_product_id_fkey" FOREIGN KEY ("market_id", "product_id") REFERENCES "catalog"."products"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."offer_post_review_reasons" ADD CONSTRAINT "offer_post_review_reasons_market_id_post_review_id_offer_i_fkey" FOREIGN KEY ("market_id", "post_review_id", "offer_id") REFERENCES "catalog"."offer_post_reviews"("market_id", "id", "offer_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): CHECKs, the open-row partial unique, the guards and grants.
ALTER TABLE "catalog"."offer_post_reviews"
  ADD CONSTRAINT "offer_post_reviews_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_post_reviews_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_post_reviews_status_check" CHECK ("status" IN ('open', 'approved', 'taken-down')),
  -- Non-empty, no NULL, known codes; the guard refuses a duplicate.
  ADD CONSTRAINT "offer_post_reviews_reasons_check" CHECK (
    "reasons" IS NOT NULL
    AND array_position("reasons", NULL) IS NULL
    AND cardinality("reasons") BETWEEN 1 AND 4
    AND "reasons" <@ ARRAY['sample', 'price-no-reference', 'price-reference-unavailable',
      'price-recheck-outside']::text[]),
  -- A sample percent goes with the `sample` reason (0 never samples, so it is 1 to 100).
  ADD CONSTRAINT "offer_post_reviews_sample_check" CHECK (
    ("sample_percent" IS NOT NULL) = ('sample' = ANY ("reasons"))
    AND ("sample_percent" IS NULL OR "sample_percent" BETWEEN 1 AND 100)
    AND (NOT "sample_doubled" OR "sample_percent" IS NOT NULL)),
  ADD CONSTRAINT "offer_post_reviews_decided_check" CHECK (
    CASE "status"
      WHEN 'open' THEN "decided_at" IS NULL AND "decided_by_account_id" IS NULL
        AND "decision_reason_code" IS NULL AND "misconduct" IS NULL AND "note" IS NULL
      WHEN 'approved' THEN "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL
        AND "decision_reason_code" IS NULL AND "misconduct" IS NULL
      ELSE "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL
        AND "decision_reason_code" IS NOT NULL AND "misconduct" IS NOT NULL AND "note" IS NOT NULL
    END),
  ADD CONSTRAINT "offer_post_reviews_decision_reason_code_check" CHECK (
    "decision_reason_code" IS NULL OR "decision_reason_code" IN
      ('content-unclear', 'description-claim', 'sku-or-condition', 'handling-unclear', 'other')),
  ADD CONSTRAINT "offer_post_reviews_note_check" CHECK (
    "note" IS NULL OR char_length("note") BETWEEN 1 AND 2000),
  ADD CONSTRAINT "offer_post_reviews_times_check" CHECK (
    "updated_at" >= "opened_at" AND ("decided_at" IS NULL OR "decided_at" >= "opened_at")),
  ADD CONSTRAINT "offer_post_reviews_version_check" CHECK ("version" >= 1);

-- At most one open row per Offer.
CREATE UNIQUE INDEX "offer_post_reviews_open_offer_key"
  ON "catalog"."offer_post_reviews"("market_id", "offer_id") WHERE "status" = 'open';
-- The decided tabs sorted by the decision (decided_at is never null there).
CREATE INDEX "offer_post_reviews_decided_idx"
  ON "catalog"."offer_post_reviews"("market_id", "status", "decided_at", "opened_at", "id")
  WHERE "status" <> 'open';

-- Born open at version 1; while open only reasons are added (the old ones kept, each once) and
-- the sample columns set with `sample`; decided once (open -> approved | taken-down); version +1
-- per UPDATE; never deleted. Data design 5.1 rules (SECURITY INVOKER, pinned path).
CREATE FUNCTION "catalog"."offer_post_reviews_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.offer_post_reviews: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.updated_at < statement_timestamp() - interval '5 minutes'
     OR NEW.updated_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'catalog.offer_post_reviews: updated_at outside tolerance' USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(ARRAY(SELECT DISTINCT unnest(NEW.reasons))) <> cardinality(NEW.reasons) THEN
    RAISE EXCEPTION 'catalog.offer_post_reviews: a reason is listed once' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.version <> 1 OR NEW.updated_at <> NEW.opened_at THEN
      RAISE EXCEPTION 'catalog.offer_post_reviews: a row is inserted open at version 1' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.market_id, NEW.tenant_id, NEW.offer_id, NEW.seller_id, NEW.product_id, NEW.opened_at)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.tenant_id, OLD.offer_id, OLD.seller_id, OLD.product_id, OLD.opened_at) THEN
    RAISE EXCEPTION 'catalog.offer_post_reviews: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'catalog.offer_post_reviews: version must rise by one' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'catalog.offer_post_reviews: a decided row never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'open' THEN
    -- Adding reasons: the old ones kept, at least one new; the sample columns move only with `sample`.
    IF NOT (OLD.reasons <@ NEW.reasons) OR cardinality(NEW.reasons) <= cardinality(OLD.reasons) THEN
      RAISE EXCEPTION 'catalog.offer_post_reviews: an open row only gains reasons' USING ERRCODE = 'check_violation';
    END IF;
    IF ('sample' = ANY (OLD.reasons) OR NOT ('sample' = ANY (NEW.reasons)))
       AND (NEW.sample_percent, NEW.sample_doubled) IS DISTINCT FROM (OLD.sample_percent, OLD.sample_doubled) THEN
      RAISE EXCEPTION 'catalog.offer_post_reviews: the sample is set once, with its reason' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- A decision: the reasons and the sample stay as they are.
  IF (NEW.reasons, NEW.sample_percent, NEW.sample_doubled)
     IS DISTINCT FROM (OLD.reasons, OLD.sample_percent, OLD.sample_doubled) THEN
    RAISE EXCEPTION 'catalog.offer_post_reviews: a decision changes no reason' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.decided_at < statement_timestamp() - interval '5 minutes'
     OR NEW.decided_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'catalog.offer_post_reviews: decided_at outside tolerance' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "offer_post_reviews_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "catalog"."offer_post_reviews"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."offer_post_reviews_guard"();
CREATE TRIGGER "offer_post_reviews_no_truncate" BEFORE TRUNCATE
  ON "catalog"."offer_post_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- catalog.offer_post_review_reasons: insert-only.
ALTER TABLE "catalog"."offer_post_review_reasons"
  ADD CONSTRAINT "offer_post_review_reasons_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_post_review_reasons_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_post_review_reasons_reason_check" CHECK ("reason" IN
    ('sample', 'price-no-reference', 'price-reference-unavailable', 'price-recheck-outside')),
  -- A price record id, or `offer-version:<n>` for a sample.
  ADD CONSTRAINT "offer_post_review_reasons_source_ref_check" CHECK (
    "source_ref" ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|offer-version:[1-9][0-9]{0,9})$'),
  -- A sample is keyed on the Offer version drawn; a price reason on its pricing record.
  ADD CONSTRAINT "offer_post_review_reasons_source_kind_check" CHECK (
    ("reason" = 'sample') = ("source_ref" LIKE 'offer-version:%'));

CREATE FUNCTION "catalog"."offer_post_review_reasons_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.received_at < statement_timestamp() - interval '5 minutes'
     OR NEW.received_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'catalog.offer_post_review_reasons: received_at outside tolerance' USING ERRCODE = 'check_violation';
  END IF;
  -- A reason is received onto the open row that carries it (the unit writes the row first).
  IF NOT EXISTS (
    SELECT 1 FROM "catalog"."offer_post_reviews" r
    WHERE r.market_id = NEW.market_id AND r.id = NEW.post_review_id AND r.offer_id = NEW.offer_id
      AND r.status = 'open' AND NEW.reason = ANY (r.reasons)) THEN
    RAISE EXCEPTION 'catalog.offer_post_review_reasons: the row is not open with this reason' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "offer_post_review_reasons_guard" BEFORE INSERT
  ON "catalog"."offer_post_review_reasons"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."offer_post_review_reasons_guard"();
CREATE TRIGGER "offer_post_review_reasons_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."offer_post_review_reasons"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "offer_post_review_reasons_no_truncate" BEFORE TRUNCATE
  ON "catalog"."offer_post_review_reasons"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- A take-down supersedes the Offer's held change (cause `taken-down`).
ALTER TABLE "catalog"."offer_pending_changes" DROP CONSTRAINT "offer_pending_changes_superseded_cause_check";
ALTER TABLE "catalog"."offer_pending_changes"
  ADD CONSTRAINT "offer_pending_changes_superseded_cause_check" CHECK (
    ("status" = 'superseded') = ("superseded_cause" IS NOT NULL)
    AND ("superseded_cause" IS NULL OR "superseded_cause" IN ('resubmitted', 'offer-deleted', 'taken-down')));

-- Grants (least privilege).
GRANT SELECT, INSERT ON TABLE "catalog"."offer_post_reviews" TO "mondapac_app";
GRANT UPDATE ("status", "reasons", "sample_percent", "sample_doubled", "updated_at", "decided_at",
  "decided_by_account_id", "decision_reason_code", "misconduct", "note", "version")
  ON TABLE "catalog"."offer_post_reviews" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."offer_post_review_reasons" TO "mondapac_app";
