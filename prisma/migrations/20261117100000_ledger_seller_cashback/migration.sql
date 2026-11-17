-- Customers management phase 4c: a seller's cashback for its exclusive customer. The cashback is
-- credited to the customer's wallet when the seller order is delivered (promotions), and the
-- seller pays it from the payout of the same seller order: one `cashback-seller` debit per
-- promotions credit, with no line, no rate and the credit as its source. The kind checks are
-- replaced as a group, as 20261025190000 did; existing rows hold only the old kinds, so every new
-- check holds for them. No new column, index or grant (the fact key already carries the source;
-- the app role already inserts).
SET lock_timeout = '5s';

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
