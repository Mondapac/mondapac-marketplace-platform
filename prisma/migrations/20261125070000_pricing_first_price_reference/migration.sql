-- Risk-based Offer approval, R4 (ADR-0051; design catalog/offer-approval section 6): a seller's
-- first regular price on a Variant is measured against the median of the other live Offers'
-- regular prices. Three nullable columns on the regular records (the reference a held or accepted
-- first price was measured against) and a new, empty table of the checks. No backfill: prices set
-- before this migration have no check row and are never re-checked.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "pricing"."regular_price_records" ADD COLUMN     "reference_amount_minor" BIGINT,
ADD COLUMN     "reference_band_percent" INTEGER,
ADD COLUMN     "reference_businesses" INTEGER;

-- CreateTable
CREATE TABLE "pricing"."first_price_checks" (
    "record_id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "series_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "reference_amount_minor" BIGINT,
    "reference_businesses" INTEGER NOT NULL,
    "businesses_needed" INTEGER NOT NULL,
    "band_percent" INTEGER NOT NULL,
    "post_review_reason" TEXT,
    "checked_at" TIMESTAMPTZ(6) NOT NULL,
    "rechecked_at" TIMESTAMPTZ(6),
    "recheck_outcome" TEXT,
    "recheck_reference_amount_minor" BIGINT,
    "recheck_amount_minor" BIGINT,

    CONSTRAINT "first_price_checks_pkey" PRIMARY KEY ("record_id")
);

-- AddForeignKey
ALTER TABLE "pricing"."first_price_checks" ADD CONSTRAINT "first_price_checks_market_id_series_id_record_id_fkey" FOREIGN KEY ("market_id", "series_id", "record_id") REFERENCES "pricing"."regular_price_records"("market_id", "series_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): the reference on a regular record. All three set or all null;
-- only on a record with no anchor (a first price); amounts in the record range; the band and the
-- count are the settings' ranges (settings definitions: 5 to 200 percent, 2 to 20 businesses,
-- widened here so a later change of those bounds needs no migration). A held record is measured
-- against an anchor or a reference: the hold-direction CHECK is replaced to allow the second.
-- New constraints are added NOT VALID and validated after, so the ADD takes no long lock (the
-- existing rows all have NULL in the new columns).
ALTER TABLE "pricing"."regular_price_records"
  ADD CONSTRAINT "regular_price_records_reference_check" CHECK (
    ("reference_amount_minor" IS NULL) = ("reference_businesses" IS NULL)
    AND ("reference_amount_minor" IS NULL) = ("reference_band_percent" IS NULL)
    AND ("reference_amount_minor" IS NULL OR "anchor_record_id" IS NULL)
    AND ("reference_amount_minor" IS NULL
         OR ("reference_amount_minor" > 0 AND "reference_amount_minor" <= 9007199254740991
             AND "reference_businesses" BETWEEN 1 AND 1000
             AND "reference_band_percent" BETWEEN 1 AND 1000))) NOT VALID;
ALTER TABLE "pricing"."regular_price_records"
  VALIDATE CONSTRAINT "regular_price_records_reference_check";

ALTER TABLE "pricing"."regular_price_records"
  DROP CONSTRAINT "regular_price_records_hold_direction_check",
  ADD CONSTRAINT "regular_price_records_hold_direction_check" CHECK (
    ("hold_direction" IS NULL) = ("status" = 'accepted')
    AND ("hold_direction" IS NULL
         OR "anchor_record_id" IS NULL
         OR ("hold_direction" = 'up' AND "amount_minor" > "anchor_amount_minor")
         OR ("hold_direction" = 'down' AND "amount_minor" < "anchor_amount_minor"))
    AND ("hold_direction" IS NULL
         OR "anchor_record_id" IS NOT NULL
         OR "reference_amount_minor" IS NOT NULL)) NOT VALID;
ALTER TABLE "pricing"."regular_price_records"
  VALIDATE CONSTRAINT "regular_price_records_hold_direction_check";

-- The write-once trigger now also covers the reference columns (record content never changes).
CREATE OR REPLACE FUNCTION "pricing"."regular_price_records_guard_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW."id", NEW."market_id", NEW."tenant_id", NEW."series_id", NEW."amount_minor", NEW."currency",
      NEW."tax_inclusive", NEW."submitted_at", NEW."submitted_by_account_id", NEW."anchor_record_id",
      NEW."anchor_amount_minor", NEW."hold_direction", NEW."reference_amount_minor",
      NEW."reference_businesses", NEW."reference_band_percent")
     IS DISTINCT FROM
     (OLD."id", OLD."market_id", OLD."tenant_id", OLD."series_id", OLD."amount_minor", OLD."currency",
      OLD."tax_inclusive", OLD."submitted_at", OLD."submitted_by_account_id", OLD."anchor_record_id",
      OLD."anchor_amount_minor", OLD."hold_direction", OLD."reference_amount_minor",
      OLD."reference_businesses", OLD."reference_band_percent") THEN
    RAISE EXCEPTION 'pricing.regular_price_records: record content is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'pending-review' AND NEW."status" IN ('approved', 'rejected', 'superseded')) THEN
    RAISE EXCEPTION 'pricing.regular_price_records: status % -> % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."effective_from" IS NOT NULL AND NEW."effective_from" IS DISTINCT FROM OLD."effective_from")
     OR (OLD."effective_to" IS NOT NULL AND NEW."effective_to" IS DISTINCT FROM OLD."effective_to")
     OR (OLD."decided_at" IS NOT NULL AND NEW."decided_at" IS DISTINCT FROM OLD."decided_at")
     OR (OLD."decided_by_account_id" IS NOT NULL AND NEW."decided_by_account_id" IS DISTINCT FROM OLD."decided_by_account_id")
     OR (OLD."decision_reason_code" IS NOT NULL AND NEW."decision_reason_code" IS DISTINCT FROM OLD."decision_reason_code")
     OR (OLD."decision_note" IS NOT NULL AND NEW."decision_note" IS DISTINCT FROM OLD."decision_note")
     OR (OLD."superseded_at" IS NOT NULL AND NEW."superseded_at" IS DISTINCT FROM OLD."superseded_at")
     OR (OLD."superseded_by_record_id" IS NOT NULL AND NEW."superseded_by_record_id" IS DISTINCT FROM OLD."superseded_by_record_id")
     OR (OLD."supersede_cause" IS NOT NULL AND NEW."supersede_cause" IS DISTINCT FROM OLD."supersede_cause") THEN
    RAISE EXCEPTION 'pricing.regular_price_records: a written-once column cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = OLD."status"
     AND (NEW."effective_from", NEW."decided_at", NEW."decided_by_account_id", NEW."decision_reason_code",
          NEW."decision_note", NEW."superseded_at", NEW."superseded_by_record_id", NEW."supersede_cause")
         IS DISTINCT FROM
         (OLD."effective_from", OLD."decided_at", OLD."decided_by_account_id", OLD."decision_reason_code",
          OLD."decision_note", OLD."superseded_at", OLD."superseded_by_record_id", OLD."supersede_cause") THEN
    RAISE EXCEPTION 'pricing.regular_price_records: decision columns change only with the status' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

-- Hand-written (database-designer): the value CHECKs of the checks table.
ALTER TABLE "pricing"."first_price_checks"
  ADD CONSTRAINT "first_price_checks_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "first_price_checks_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "first_price_checks_outcome_check" CHECK (
    "outcome" IN ('no-reference', 'reference-unavailable', 'within', 'outside')),
  ADD CONSTRAINT "first_price_checks_reference_check" CHECK (
    ("reference_amount_minor" IS NOT NULL) = ("outcome" IN ('within', 'outside'))
    AND ("reference_amount_minor" IS NULL
         OR ("reference_amount_minor" > 0 AND "reference_amount_minor" <= 9007199254740991))),
  ADD CONSTRAINT "first_price_checks_counts_check" CHECK (
    "reference_businesses" BETWEEN 0 AND 1000
    AND "businesses_needed" BETWEEN 0 AND 1000
    AND "band_percent" BETWEEN 0 AND 1000),
  ADD CONSTRAINT "first_price_checks_post_review_check" CHECK (
    "post_review_reason" IS NULL
    OR ("post_review_reason" IN ('no-reference', 'reference-unavailable')
        AND "post_review_reason" = "outcome")
    OR ("post_review_reason" = 'recheck-outside' AND "recheck_outcome" = 'outside')),
  ADD CONSTRAINT "first_price_checks_post_review_set_check" CHECK (
    ("outcome" IN ('no-reference', 'reference-unavailable')) = ("post_review_reason" IS NOT NULL)),
  ADD CONSTRAINT "first_price_checks_recheck_check" CHECK (
    ("rechecked_at" IS NULL) = ("recheck_outcome" IS NULL)
    AND ("rechecked_at" IS NULL) = ("recheck_reference_amount_minor" IS NULL)
    AND ("rechecked_at" IS NULL) = ("recheck_amount_minor" IS NULL)
    AND ("rechecked_at" IS NULL OR "outcome" IN ('no-reference', 'reference-unavailable'))
    AND ("rechecked_at" IS NULL OR "rechecked_at" >= "checked_at")
    AND ("recheck_outcome" IS NULL OR "recheck_outcome" IN ('within', 'outside'))
    AND ("recheck_reference_amount_minor" IS NULL
         OR ("recheck_reference_amount_minor" > 0 AND "recheck_reference_amount_minor" <= 9007199254740991))
    AND ("recheck_amount_minor" IS NULL
         OR ("recheck_amount_minor" > 0 AND "recheck_amount_minor" <= 9007199254740991)));

-- The re-check's lookup (PendingRechecks): the checks of a Variant still waiting for a reference,
-- oldest first. Partial, so it holds only those rows. Invisible to Prisma, like the other partial
-- indexes.
CREATE INDEX "first_price_checks_market_id_product_id_variant_id_pending_idx"
  ON "pricing"."first_price_checks" ("market_id", "product_id", "variant_id", "checked_at", "record_id")
  WHERE "rechecked_at" IS NULL AND "outcome" IN ('no-reference', 'reference-unavailable');

-- Insert once; the re-check columns are written once, together (and the post-review reason moves
-- to `recheck-outside` with an outside re-check). No delete.
CREATE FUNCTION "pricing"."first_price_checks_guard_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."rechecked_at" IS NOT NULL
     OR (NEW."record_id", NEW."market_id", NEW."tenant_id", NEW."series_id", NEW."offer_id",
         NEW."product_id", NEW."variant_id", NEW."seller_id", NEW."outcome", NEW."reference_amount_minor",
         NEW."reference_businesses", NEW."businesses_needed", NEW."band_percent", NEW."checked_at")
        IS DISTINCT FROM
        (OLD."record_id", OLD."market_id", OLD."tenant_id", OLD."series_id", OLD."offer_id",
         OLD."product_id", OLD."variant_id", OLD."seller_id", OLD."outcome", OLD."reference_amount_minor",
         OLD."reference_businesses", OLD."businesses_needed", OLD."band_percent", OLD."checked_at") THEN
    RAISE EXCEPTION 'pricing.first_price_checks: a check is re-checked once, its content never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "first_price_checks_write_once" BEFORE UPDATE ON "pricing"."first_price_checks"
  FOR EACH ROW EXECUTE FUNCTION "pricing"."first_price_checks_guard_update"();
CREATE TRIGGER "first_price_checks_no_delete" BEFORE DELETE ON "pricing"."first_price_checks"
  FOR EACH ROW EXECUTE FUNCTION "pricing"."reject_mutation"();
CREATE TRIGGER "first_price_checks_no_truncate" BEFORE TRUNCATE ON "pricing"."first_price_checks"
  FOR EACH STATEMENT EXECUTE FUNCTION "pricing"."reject_mutation"();

-- Grants (database-designer): the API inserts checks and writes the re-check columns only. The
-- new record columns are insert-only (the table's UPDATE grant is per column and does not name them).
GRANT SELECT, INSERT, UPDATE ("post_review_reason", "rechecked_at", "recheck_outcome",
  "recheck_reference_amount_minor", "recheck_amount_minor")
  ON TABLE "pricing"."first_price_checks" TO "mondapac_app";
