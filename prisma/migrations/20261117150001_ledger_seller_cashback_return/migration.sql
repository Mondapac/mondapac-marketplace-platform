-- Customers management phase 4c-2: when a refund takes back part of a seller's cashback from the
-- customer's wallet, the seller gets that part back on the payout of the same seller order: one
-- `refund-cashback-seller` credit per promotions clawback, with no line, no rate and the clawback
-- as its source. The kind checks are replaced as a group, as 20261117100000 did; existing rows
-- hold only the old kinds, so every new check holds for them. No new column, index or grant.
-- A plain ADD is safe: no deployed environment holds ledger rows yet; a populated table would need
-- ADD ... NOT VALID in one migration and VALIDATE in the next. Safety: a blocked statement fails
-- instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "commission_payouts"."ledger_entries"
  DROP CONSTRAINT "ledger_entries_kind_check",
  DROP CONSTRAINT "ledger_entries_source_check",
  DROP CONSTRAINT "ledger_entries_line_check",
  ADD CONSTRAINT "ledger_entries_kind_check" CHECK ("kind" IN (
    'sale', 'shipping', 'commission',
    'refund-sale', 'refund-shipping', 'refund-commission',
    'dispute-debit', 'dispute-reinstate',
    'cashback-seller', 'refund-cashback-seller')),
  -- The original kinds belong to the paid seller order and have no source; every reversal, dispute
  -- or cashback row names the refund, dispute, promotions credit or clawback it comes from.
  ADD CONSTRAINT "ledger_entries_source_check" CHECK (
    ("kind" IN ('sale', 'shipping', 'commission') AND "source_id" IS NULL)
    OR ("kind" IN ('refund-sale', 'refund-shipping', 'refund-commission', 'dispute-debit', 'dispute-reinstate',
      'cashback-seller', 'refund-cashback-seller')
      AND "source_id" IS NOT NULL)),
  -- Shipping, its reversal, the dispute rows and a seller's cashback and its return have no line;
  -- sale, commission and their reversals have one.
  ADD CONSTRAINT "ledger_entries_line_check" CHECK (
    ("kind" IN ('shipping', 'refund-shipping', 'dispute-debit', 'dispute-reinstate', 'cashback-seller',
      'refund-cashback-seller'))
    = ("order_line_id" IS NULL));
