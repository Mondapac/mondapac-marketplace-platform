-- Safety (docs/design/data/pricing.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "pricing"."special_price_records" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "series_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "tax_inclusive" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "submitted_by_account_id" UUID NOT NULL,
    "regular_record_id" UUID NOT NULL,
    "regular_amount_minor" BIGINT NOT NULL,
    "anchor_record_id" UUID NOT NULL,
    "anchor_amount_minor" BIGINT NOT NULL,
    "hold_direction" TEXT,
    "effective_from" TIMESTAMPTZ(6),
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdraw_cause" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_account_id" UUID,
    "decision_reason_code" TEXT,
    "decision_note" TEXT,
    "superseded_at" TIMESTAMPTZ(6),
    "superseded_by_record_id" UUID,
    "supersede_cause" TEXT,

    CONSTRAINT "special_price_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "special_price_records_market_id_series_id_id_key" ON "pricing"."special_price_records"("market_id", "series_id", "id");

-- AddForeignKey
ALTER TABLE "pricing"."special_price_records" ADD CONSTRAINT "special_price_records_series_id_fkey" FOREIGN KEY ("market_id", "series_id", "currency") REFERENCES "pricing"."price_series"("market_id", "id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pricing"."special_price_records" ADD CONSTRAINT "special_price_records_regular_record_id_fkey" FOREIGN KEY ("market_id", "series_id", "regular_record_id") REFERENCES "pricing"."regular_price_records"("market_id", "series_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "pricing"."special_price_records" ADD CONSTRAINT "special_price_records_anchor_record_id_fkey" FOREIGN KEY ("market_id", "series_id", "anchor_record_id") REFERENCES "pricing"."regular_price_records"("market_id", "series_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written (database-designer): docs/design/data/pricing.md 3.4 (special price records) in
-- the hybrid scope of 2026-10-14: the window is two UTC instants, no zone column. Only a new
-- table, so nothing here is NOT VALID.
ALTER TABLE "pricing"."special_price_records"
  ADD CONSTRAINT "special_price_records_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "special_price_records_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "special_price_records_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  -- P1 money; a special is always strictly below the regular price it was written against.
  ADD CONSTRAINT "special_price_records_amount_minor_check" CHECK (
    "amount_minor" > 0 AND "amount_minor" <= 9007199254740991
    AND "regular_amount_minor" <= 9007199254740991 AND "amount_minor" < "regular_amount_minor"
    AND "anchor_amount_minor" > 0 AND "anchor_amount_minor" <= 9007199254740991),
  ADD CONSTRAINT "special_price_records_status_check" CHECK (
    "status" IN ('accepted', 'pending-review', 'approved', 'rejected', 'superseded', 'withdrawn')),
  ADD CONSTRAINT "special_price_records_window_check" CHECK (
    "ends_at" > "starts_at" AND "starts_at" >= "submitted_at"),
  -- A held record carries its direction (always down); an accepted one never does; a withdrawn
  -- one was accepted (no direction, no decision) or approved (direction and decision).
  ADD CONSTRAINT "special_price_records_hold_direction_check" CHECK (
    ("hold_direction" IS NULL OR "hold_direction" = 'down')
    AND ("hold_direction" IS NOT NULL OR "status" IN ('accepted', 'withdrawn'))
    AND ("status" <> 'accepted' OR "hold_direction" IS NULL)
    AND ("status" <> 'withdrawn' OR ("hold_direction" IS NULL) = ("decided_at" IS NULL))),
  ADD CONSTRAINT "special_price_records_effective_check" CHECK (
    ("effective_from" IS NOT NULL) = ("status" IN ('accepted', 'approved', 'withdrawn'))
    AND ("effective_from" IS NULL OR ("effective_from" >= "starts_at" AND "effective_from" < "ends_at"))
    AND ("status" <> 'approved' OR "effective_from" >= "decided_at")),
  ADD CONSTRAINT "special_price_records_withdrawn_check" CHECK (
    ("withdrawn_at" IS NOT NULL) = ("status" = 'withdrawn')
    AND ("withdraw_cause" IS NOT NULL) = ("status" = 'withdrawn')
    AND ("withdrawn_at" IS NULL OR "withdrawn_at" >= "submitted_at")),
  ADD CONSTRAINT "special_price_records_withdraw_cause_check" CHECK (
    "withdraw_cause" IN ('withdrawn', 'replaced', 'offer-removed', 'variant-removed')),
  ADD CONSTRAINT "special_price_records_decision_check" CHECK (
    ("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)
    AND ("decided_at" IS NOT NULL OR "status" NOT IN ('approved', 'rejected'))
    AND ("decided_at" IS NULL OR "status" IN ('approved', 'rejected', 'withdrawn'))
    AND ("decided_at" IS NULL OR "decided_at" >= "submitted_at")
    AND ("status" <> 'rejected') = ("decision_reason_code" IS NULL)
    AND ("decision_note" IS NULL OR "status" = 'rejected')),
  ADD CONSTRAINT "special_price_records_decider_check" CHECK (
    "decided_by_account_id" IS NULL OR "decided_by_account_id" <> "submitted_by_account_id"),
  ADD CONSTRAINT "special_price_records_decision_reason_code_check" CHECK (
    "decision_reason_code" ~ '^[a-z][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT "special_price_records_decision_note_check" CHECK (
    char_length("decision_note") BETWEEN 1 AND 1000
    AND "decision_note" = btrim("decision_note")
    AND "decision_note" !~ '[\u0001-\u0009\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'),
  ADD CONSTRAINT "special_price_records_superseded_check" CHECK (
    ("superseded_at" IS NOT NULL) = ("status" = 'superseded')
    AND ("supersede_cause" IS NOT NULL) = ("status" = 'superseded')
    AND ("superseded_by_record_id" IS NOT NULL) = coalesce("supersede_cause" = 'replaced', false)
    AND ("superseded_by_record_id" IS NULL OR "superseded_by_record_id" <> "id")),
  ADD CONSTRAINT "special_price_records_supersede_cause_check" CHECK (
    "supersede_cause" IN ('replaced', 'cancelled', 'offer-removed', 'variant-removed'));

-- Effective periods never overlap (PD2, M4): [effective_from, min(ends_at, withdrawn_at)), a
-- period withdrawn before it started is empty. A unit shortens the old period (withdraw) before
-- it starts the next one, as for regular records (P7). Pending, rejected and superseded rows are
-- outside the constraint.
ALTER TABLE "pricing"."special_price_records"
  ADD CONSTRAINT "special_price_records_effective_period_excl" EXCLUDE USING gist (
    "market_id" WITH =, "series_id" WITH =,
    tstzrange("effective_from",
      greatest("effective_from", least("ends_at", coalesce("withdrawn_at", 'infinity'::timestamptz))),
      '[)') WITH &&)
    WHERE ("status" IN ('accepted', 'approved', 'withdrawn'));

-- At most one pending special per series (PD2).
CREATE UNIQUE INDEX "special_price_records_market_id_series_id_pending_key"
  ON "pricing"."special_price_records" ("market_id", "series_id") WHERE "status" = 'pending-review';

-- The review queue's keyset read of pending specials (PD5), as for regular records.
CREATE INDEX "special_price_records_market_id_submitted_at_id_pending_idx"
  ON "pricing"."special_price_records" ("market_id", "submitted_at", "id") WHERE "status" = 'pending-review';

-- Record content never changes; status moves only pending-review -> approved, rejected or
-- superseded, and accepted or approved -> withdrawn; a written-once column never changes again;
-- the written columns change only with the status. Function conventions as for regular records.
CREATE FUNCTION "pricing"."special_price_records_guard_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW."id", NEW."market_id", NEW."tenant_id", NEW."series_id", NEW."amount_minor", NEW."currency",
      NEW."tax_inclusive", NEW."starts_at", NEW."ends_at", NEW."submitted_at", NEW."submitted_by_account_id",
      NEW."regular_record_id", NEW."regular_amount_minor", NEW."anchor_record_id", NEW."anchor_amount_minor",
      NEW."hold_direction")
     IS DISTINCT FROM
     (OLD."id", OLD."market_id", OLD."tenant_id", OLD."series_id", OLD."amount_minor", OLD."currency",
      OLD."tax_inclusive", OLD."starts_at", OLD."ends_at", OLD."submitted_at", OLD."submitted_by_account_id",
      OLD."regular_record_id", OLD."regular_amount_minor", OLD."anchor_record_id", OLD."anchor_amount_minor",
      OLD."hold_direction") THEN
    RAISE EXCEPTION 'pricing.special_price_records: record content is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT ((OLD."status" = 'pending-review' AND NEW."status" IN ('approved', 'rejected', 'superseded'))
              OR (OLD."status" IN ('accepted', 'approved') AND NEW."status" = 'withdrawn')) THEN
    RAISE EXCEPTION 'pricing.special_price_records: status % -> % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."effective_from" IS NOT NULL AND NEW."effective_from" IS DISTINCT FROM OLD."effective_from")
     OR (OLD."withdrawn_at" IS NOT NULL AND NEW."withdrawn_at" IS DISTINCT FROM OLD."withdrawn_at")
     OR (OLD."withdraw_cause" IS NOT NULL AND NEW."withdraw_cause" IS DISTINCT FROM OLD."withdraw_cause")
     OR (OLD."decided_at" IS NOT NULL AND NEW."decided_at" IS DISTINCT FROM OLD."decided_at")
     OR (OLD."decided_by_account_id" IS NOT NULL AND NEW."decided_by_account_id" IS DISTINCT FROM OLD."decided_by_account_id")
     OR (OLD."decision_reason_code" IS NOT NULL AND NEW."decision_reason_code" IS DISTINCT FROM OLD."decision_reason_code")
     OR (OLD."decision_note" IS NOT NULL AND NEW."decision_note" IS DISTINCT FROM OLD."decision_note")
     OR (OLD."superseded_at" IS NOT NULL AND NEW."superseded_at" IS DISTINCT FROM OLD."superseded_at")
     OR (OLD."superseded_by_record_id" IS NOT NULL AND NEW."superseded_by_record_id" IS DISTINCT FROM OLD."superseded_by_record_id")
     OR (OLD."supersede_cause" IS NOT NULL AND NEW."supersede_cause" IS DISTINCT FROM OLD."supersede_cause") THEN
    RAISE EXCEPTION 'pricing.special_price_records: a written-once column cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = OLD."status"
     AND (NEW."effective_from", NEW."withdrawn_at", NEW."withdraw_cause", NEW."decided_at", NEW."decided_by_account_id",
          NEW."decision_reason_code", NEW."decision_note", NEW."superseded_at", NEW."superseded_by_record_id",
          NEW."supersede_cause")
         IS DISTINCT FROM
         (OLD."effective_from", OLD."withdrawn_at", OLD."withdraw_cause", OLD."decided_at", OLD."decided_by_account_id",
          OLD."decision_reason_code", OLD."decision_note", OLD."superseded_at", OLD."superseded_by_record_id",
          OLD."supersede_cause") THEN
    RAISE EXCEPTION 'pricing.special_price_records: written columns change only with the status' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "special_price_records_write_once" BEFORE UPDATE ON "pricing"."special_price_records"
  FOR EACH ROW EXECUTE FUNCTION "pricing"."special_price_records_guard_update"();
CREATE TRIGGER "special_price_records_no_delete" BEFORE DELETE ON "pricing"."special_price_records"
  FOR EACH ROW EXECUTE FUNCTION "pricing"."reject_mutation"();
CREATE TRIGGER "special_price_records_no_truncate" BEFORE TRUNCATE ON "pricing"."special_price_records"
  FOR EACH STATEMENT EXECUTE FUNCTION "pricing"."reject_mutation"();

-- Grants (database-designer): to mondapac_app only; no DELETE (P6).
GRANT SELECT, INSERT, UPDATE ("status", "effective_from", "withdrawn_at", "withdraw_cause",
  "decided_at", "decided_by_account_id", "decision_reason_code", "decision_note", "superseded_at",
  "superseded_by_record_id", "supersede_cause")
  ON TABLE "pricing"."special_price_records" TO "mondapac_app";
