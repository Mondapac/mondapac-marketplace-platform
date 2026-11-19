-- Reverses 20261117150001_ledger_seller_cashback_return: the checks as 20261117100000 wrote them.
-- A `refund-cashback-seller` row would break them, so the down refuses while one exists.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "commission_payouts"."ledger_entries" WHERE "kind" = 'refund-cashback-seller') THEN
    RAISE EXCEPTION 'commission_payouts.ledger_entries: refund-cashback-seller rows exist';
  END IF;
END $$;

ALTER TABLE "commission_payouts"."ledger_entries"
  DROP CONSTRAINT "ledger_entries_kind_check",
  DROP CONSTRAINT "ledger_entries_source_check",
  DROP CONSTRAINT "ledger_entries_line_check",
  ADD CONSTRAINT "ledger_entries_kind_check" CHECK ("kind" IN (
    'sale', 'shipping', 'commission',
    'refund-sale', 'refund-shipping', 'refund-commission',
    'dispute-debit', 'dispute-reinstate',
    'cashback-seller')),
  -- The original kinds belong to the paid seller order and have no source; every reversal, dispute
  -- or cashback row names the refund, dispute or promotions credit it comes from.
  ADD CONSTRAINT "ledger_entries_source_check" CHECK (
    ("kind" IN ('sale', 'shipping', 'commission') AND "source_id" IS NULL)
    OR ("kind" IN ('refund-sale', 'refund-shipping', 'refund-commission', 'dispute-debit', 'dispute-reinstate',
      'cashback-seller')
      AND "source_id" IS NOT NULL)),
  -- Shipping, its reversal, the dispute rows and a seller's cashback have no line; sale, commission
  -- and their reversals have one.
  ADD CONSTRAINT "ledger_entries_line_check" CHECK (
    ("kind" IN ('shipping', 'refund-shipping', 'dispute-debit', 'dispute-reinstate', 'cashback-seller'))
    = ("order_line_id" IS NULL));
