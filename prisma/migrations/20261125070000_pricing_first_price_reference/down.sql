-- Reverses 20261125070000_pricing_first_price_reference. The R4 checks and the references copied
-- on first-price records are lost; the records and their statuses stay. A held first price that
-- was held against a reference keeps its pending status but loses the reason it was held, so the
-- down migration refuses while such a record is pending (an admin decides it first).
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "pricing"."regular_price_records"
             WHERE "anchor_record_id" IS NULL AND "hold_direction" IS NOT NULL) THEN
    RAISE EXCEPTION 'pricing: a first price held against a reference is still recorded; decide or keep it before going down';
  END IF;
END
$guard$;

DROP TABLE "pricing"."first_price_checks";
DROP FUNCTION "pricing"."first_price_checks_guard_update"();

CREATE OR REPLACE FUNCTION "pricing"."regular_price_records_guard_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW."id", NEW."market_id", NEW."tenant_id", NEW."series_id", NEW."amount_minor", NEW."currency",
      NEW."tax_inclusive", NEW."submitted_at", NEW."submitted_by_account_id", NEW."anchor_record_id",
      NEW."anchor_amount_minor", NEW."hold_direction")
     IS DISTINCT FROM
     (OLD."id", OLD."market_id", OLD."tenant_id", OLD."series_id", OLD."amount_minor", OLD."currency",
      OLD."tax_inclusive", OLD."submitted_at", OLD."submitted_by_account_id", OLD."anchor_record_id",
      OLD."anchor_amount_minor", OLD."hold_direction") THEN
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

ALTER TABLE "pricing"."regular_price_records"
  DROP CONSTRAINT "regular_price_records_hold_direction_check",
  DROP CONSTRAINT "regular_price_records_reference_check",
  ADD CONSTRAINT "regular_price_records_hold_direction_check" CHECK (
    ("hold_direction" IS NULL) = ("status" = 'accepted')
    AND ("hold_direction" IS NULL
         OR ("hold_direction" = 'up' AND "amount_minor" > "anchor_amount_minor")
         OR ("hold_direction" = 'down' AND "amount_minor" < "anchor_amount_minor"))
    AND ("hold_direction" IS NULL OR "anchor_record_id" IS NOT NULL));

ALTER TABLE "pricing"."regular_price_records" DROP COLUMN "reference_amount_minor",
DROP COLUMN "reference_band_percent",
DROP COLUMN "reference_businesses";
