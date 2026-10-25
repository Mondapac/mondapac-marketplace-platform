-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261025140000_ledger_refund_reversals. The ordering side goes first: the grant, the
-- queue index, the checks and the four columns, and the settle guard returns to its first body.
REVOKE UPDATE ("ledger_attempts", "ledger_recorded_at") ON TABLE "ordering"."refunds" FROM "mondapac_app";

CREATE OR REPLACE FUNCTION "ordering"."refunds_settle_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."state" <> 'pending' THEN
    RAISE EXCEPTION 'ordering.refunds: a settled refund never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'ordering.refunds: attempts only grow' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."stripe_refund_id" IS NOT NULL
     AND NEW."stripe_refund_id" IS DISTINCT FROM OLD."stripe_refund_id" THEN
    RAISE EXCEPTION 'ordering.refunds: the Stripe refund id never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP INDEX "ordering"."refunds_unrecorded_ledger_idx";
ALTER TABLE "ordering"."refunds"
  DROP CONSTRAINT "refunds_shipping_before_check",
  DROP CONSTRAINT "refunds_ledger_check",
  DROP CONSTRAINT "refunds_loss_pair_check",
  DROP CONSTRAINT "refunds_loss_reason_code_check",
  DROP CONSTRAINT "refunds_loss_bearer_check",
  DROP COLUMN "shipping_before",
  DROP COLUMN "ledger_attempts",
  DROP COLUMN "ledger_recorded_at",
  DROP COLUMN "loss_reason_code",
  DROP COLUMN "loss_bearer";

-- The ledger: the rows of the five new kinds are lost (the original kinds stay). DEVELOPMENT ONLY:
-- no deployed environment exists, and a down of a populated ledger must never run. The ledger is
-- insert-only, so the delete trigger is switched off for this one statement and back on. That is
-- safe only because the whole file runs in ONE transaction (the reversibility check sends it as a
-- single multi-statement query, and the migrate tooling applies a file in one transaction): if
-- the DELETE fails, the DISABLE rolls back with it and the trigger is never left off. Do not run
-- these statements by hand outside a transaction.
ALTER TABLE "commission_payouts"."ledger_entries" DISABLE TRIGGER "ledger_entries_no_delete";
DELETE FROM "commission_payouts"."ledger_entries" WHERE "source_id" IS NOT NULL;
ALTER TABLE "commission_payouts"."ledger_entries" ENABLE TRIGGER "ledger_entries_no_delete";

ALTER TABLE "commission_payouts"."ledger_entries"
  DROP CONSTRAINT "ledger_entries_commission_check",
  DROP CONSTRAINT "ledger_entries_line_check",
  DROP CONSTRAINT "ledger_entries_positive_credit_check",
  DROP CONSTRAINT "ledger_entries_source_check",
  DROP CONSTRAINT "ledger_entries_kind_check",
  ADD CONSTRAINT "ledger_entries_kind_check" CHECK ("kind" IN ('sale', 'shipping', 'commission')),
  ADD CONSTRAINT "ledger_entries_positive_credit_check" CHECK ("kind" = 'commission' OR "amount" > 0),
  ADD CONSTRAINT "ledger_entries_line_check" CHECK (("kind" = 'shipping') = ("order_line_id" IS NULL)),
  ADD CONSTRAINT "ledger_entries_commission_check" CHECK (
    ("kind" = 'commission' AND "rate_bps" IS NOT NULL AND "base_amount" IS NOT NULL
      AND "rate_bps" BETWEEN 0 AND 3000 AND "base_amount" >= 0 AND "amount" <= "base_amount")
    OR ("kind" <> 'commission' AND "rate_bps" IS NULL AND "base_amount" IS NULL));

DROP INDEX "commission_payouts"."ledger_entries_fact_key";
CREATE UNIQUE INDEX "ledger_entries_market_id_seller_order_id_kind_order_line_id_key"
  ON "commission_payouts"."ledger_entries" ("market_id", "seller_order_id", "kind", "order_line_id")
  NULLS NOT DISTINCT;
ALTER TABLE "commission_payouts"."ledger_entries" DROP COLUMN "source_id";
