SET lock_timeout = '5s';

-- Refuses while a seller's cashback is in the ledger: the old checks cannot hold it, and the money
-- row is never deleted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "commission_payouts"."ledger_entries" WHERE "kind" = 'cashback-seller') THEN
    RAISE EXCEPTION 'ledger_entries holds cashback-seller rows: cannot go down';
  END IF;
END $$;

ALTER TABLE "commission_payouts"."ledger_entries"
  DROP CONSTRAINT "ledger_entries_kind_check",
  DROP CONSTRAINT "ledger_entries_source_check",
  DROP CONSTRAINT "ledger_entries_line_check",
  ADD CONSTRAINT "ledger_entries_kind_check" CHECK ("kind" IN (
    'sale', 'shipping', 'commission',
    'refund-sale', 'refund-shipping', 'refund-commission',
    'dispute-debit', 'dispute-reinstate')),
  ADD CONSTRAINT "ledger_entries_source_check" CHECK (
    ("kind" IN ('sale', 'shipping', 'commission') AND "source_id" IS NULL)
    OR ("kind" IN ('refund-sale', 'refund-shipping', 'refund-commission', 'dispute-debit', 'dispute-reinstate')
      AND "source_id" IS NOT NULL)),
  ADD CONSTRAINT "ledger_entries_line_check" CHECK (
    ("kind" IN ('shipping', 'refund-shipping', 'dispute-debit', 'dispute-reinstate'))
    = ("order_line_id" IS NULL));
