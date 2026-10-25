-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Seller ledger refund reversals (Phase 5 package 6a). An admin refund (ordering) gives money back
-- through Stripe; the seller ledger now gets reversal rows so the seller's balance follows. Five
-- kinds join the ledger: `refund-sale`, `refund-shipping` and `refund-commission` (written by the
-- refund flow here) and `dispute-debit` and `dispute-reinstate` (allowed by the CHECK now; nothing
-- writes them before the disputes package). A refund who bears the loss is stored on the ordering
-- refund (`seller` keeps the reversal, `platform` posts nothing; owner decision Q-O2).

-- ---------------------------------------------------------------------------------------------
-- commission_payouts.ledger_entries
-- ---------------------------------------------------------------------------------------------

-- AlterTable. The id of the refund (or later the dispute) the row reverses; a plain id, no foreign
-- key across schemas. NULL for the three original kinds (CHECK below).
ALTER TABLE "commission_payouts"."ledger_entries" ADD COLUMN "source_id" UUID;

-- Hand-written: one row per fact. The key now carries the source, so several partial refunds of one
-- line each get their own rows, and a replay of the same refund conflicts and is skipped (ON
-- CONFLICT DO NOTHING). NULLS NOT DISTINCT: a shipping row has no line, an original row no source.
DROP INDEX "commission_payouts"."ledger_entries_market_id_seller_order_id_kind_order_line_id_key";
CREATE UNIQUE INDEX "ledger_entries_fact_key"
  ON "commission_payouts"."ledger_entries"
  ("market_id", "seller_order_id", "kind", "order_line_id", "source_id")
  NULLS NOT DISTINCT;

-- Hand-written: the checks that depend on the kind are replaced as a group. Existing rows hold only
-- the original kinds with a NULL source, so every new CHECK holds for them.
ALTER TABLE "commission_payouts"."ledger_entries"
  DROP CONSTRAINT "ledger_entries_kind_check",
  DROP CONSTRAINT "ledger_entries_positive_credit_check",
  DROP CONSTRAINT "ledger_entries_line_check",
  DROP CONSTRAINT "ledger_entries_commission_check",
  ADD CONSTRAINT "ledger_entries_kind_check" CHECK ("kind" IN (
    'sale', 'shipping', 'commission',
    'refund-sale', 'refund-shipping', 'refund-commission',
    'dispute-debit', 'dispute-reinstate')),
  -- The original kinds belong to the paid seller order and have no source; every reversal or
  -- dispute row names the refund or dispute it comes from.
  ADD CONSTRAINT "ledger_entries_source_check" CHECK (
    ("kind" IN ('sale', 'shipping', 'commission') AND "source_id" IS NULL)
    OR ("kind" IN ('refund-sale', 'refund-shipping', 'refund-commission', 'dispute-debit', 'dispute-reinstate')
      AND "source_id" IS NOT NULL)),
  -- Only a commission or its reversal may be zero: a reversal whose commission rounds to 0 is still
  -- recorded. A sale, a shipping fee, their reversals and a dispute row are never zero.
  ADD CONSTRAINT "ledger_entries_positive_credit_check" CHECK (
    "kind" IN ('commission', 'refund-commission') OR "amount" > 0),
  -- Shipping, its reversal and the dispute rows have no line; sale, commission and their reversals
  -- have one.
  ADD CONSTRAINT "ledger_entries_line_check" CHECK (
    ("kind" IN ('shipping', 'refund-shipping', 'dispute-debit', 'dispute-reinstate'))
    = ("order_line_id" IS NULL)),
  -- Only a commission or its reversal carries a rate and a base, and never more than it. A reversal
  -- carries the original rate and the base it reverses.
  ADD CONSTRAINT "ledger_entries_commission_check" CHECK (
    ("kind" IN ('commission', 'refund-commission') AND "rate_bps" IS NOT NULL AND "base_amount" IS NOT NULL
      AND "rate_bps" BETWEEN 0 AND 3000 AND "base_amount" >= 0 AND "amount" <= "base_amount")
    OR ("kind" NOT IN ('commission', 'refund-commission') AND "rate_bps" IS NULL AND "base_amount" IS NULL));

-- ---------------------------------------------------------------------------------------------
-- ordering.refunds
-- ---------------------------------------------------------------------------------------------

-- AlterTable. Who bears the loss of the refund (ordering data design 6; domain design 3.5). Refunds
-- already written were made before the choice existed: the seller bears them.
ALTER TABLE "ordering"."refunds" ADD COLUMN "loss_bearer" TEXT NOT NULL DEFAULT 'seller';
ALTER TABLE "ordering"."refunds" ADD COLUMN "loss_reason_code" TEXT;
-- When the worker wrote the refund into the seller ledger (or found nothing to write), and how many
-- times the ledger refused it: the worker takes the fewest refused first, as for seller orders.
ALTER TABLE "ordering"."refunds" ADD COLUMN "ledger_recorded_at" TIMESTAMPTZ(6);
ALTER TABLE "ordering"."refunds" ADD COLUMN "ledger_attempts" INTEGER NOT NULL DEFAULT 0;

-- Hand-written: value checks (the table has few rows, so no NOT VALID step).
ALTER TABLE "ordering"."refunds"
  ADD CONSTRAINT "refunds_loss_bearer_check" CHECK ("loss_bearer" IN ('seller', 'platform')),
  ADD CONSTRAINT "refunds_loss_reason_code_check" CHECK (
    "loss_reason_code" IN ('platform-error', 'carrier-loss', 'seller-unrecoverable', 'fraud-loss', 'goodwill', 'other')),
  -- The platform bearing a loss always says why; a seller-borne refund names no reason.
  ADD CONSTRAINT "refunds_loss_pair_check" CHECK (
    ("loss_bearer" = 'platform') = ("loss_reason_code" IS NOT NULL)),
  -- Only a refund Stripe confirmed reaches the ledger.
  ADD CONSTRAINT "refunds_ledger_check" CHECK (
    "ledger_attempts" >= 0 AND ("ledger_recorded_at" IS NULL OR "state" = 'succeeded'));

-- Hand-written: the worker's queue of succeeded refunds not yet in the seller ledger. Invisible to
-- Prisma.
CREATE INDEX "refunds_unrecorded_ledger_idx"
  ON "ordering"."refunds" ("market_id", "ledger_attempts", "requested_at", "id")
  WHERE "state" = 'succeeded' AND "ledger_recorded_at" IS NULL;

-- Hand-written: the settle guard of 20261019100000_ordering_refunds, extended. A settled refund
-- still never changes, except for the two ledger columns: the marker is set once and never
-- cleared, the counter only grows. While pending, the ledger columns do not change.
CREATE OR REPLACE FUNCTION "ordering"."refunds_settle_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."state" <> 'pending' THEN
    IF (to_jsonb(NEW) - 'ledger_recorded_at' - 'ledger_attempts')
       IS DISTINCT FROM (to_jsonb(OLD) - 'ledger_recorded_at' - 'ledger_attempts') THEN
      RAISE EXCEPTION 'ordering.refunds: a settled refund never changes' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."ledger_recorded_at" IS DISTINCT FROM OLD."ledger_recorded_at"
        OR NEW."ledger_attempts" IS DISTINCT FROM OLD."ledger_attempts" THEN
    RAISE EXCEPTION 'ordering.refunds: only a settled refund reaches the ledger' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'ordering.refunds: attempts only grow' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."stripe_refund_id" IS NOT NULL
     AND NEW."stripe_refund_id" IS DISTINCT FROM OLD."stripe_refund_id" THEN
    RAISE EXCEPTION 'ordering.refunds: the Stripe refund id never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ledger_attempts" < OLD."ledger_attempts" THEN
    RAISE EXCEPTION 'ordering.refunds: ledger attempts only grow' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."ledger_recorded_at" IS NOT NULL
     AND NEW."ledger_recorded_at" IS DISTINCT FROM OLD."ledger_recorded_at" THEN
    RAISE EXCEPTION 'ordering.refunds: the ledger marker never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Grants. The ledger marker and counter are the only new columns the application moves; the loss
-- bearer is written with the refund and never changes. The ledger grants are untouched: SELECT and
-- INSERT only, and the insert-only triggers stay.
GRANT UPDATE ("ledger_attempts", "ledger_recorded_at") ON TABLE "ordering"."refunds" TO "mondapac_app";
