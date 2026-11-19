-- Customers management phase 4b follow-up: the seller's savings on exclusive customers. Checkout
-- also freezes, on a line whose rate was lowered for the buyer's exclusive seller, the rate the
-- line would have carried without it (the seller's rate in force at placement). The ledger works
-- the seller's saving out of it. Nullable with no default: existing lines are not rewritten, and a
-- line lowered before this column keeps null (its saving is unknown, never guessed).
SET lock_timeout = '5s';

ALTER TABLE "ordering"."order_lines"
  ADD COLUMN "commission_standard_rate_bps" INTEGER;

-- Hand-written: only a lowered line carries it, never below the rate frozen on the line and in
-- the range of every rate (0 to 3000). Added NOT VALID and then validated: every existing row is
-- null and passes. The file runs in one transaction, so the validation still holds the lock of the
-- ADD (accepted while the table is small; on a large table VALIDATE goes in a migration of its own).
ALTER TABLE "ordering"."order_lines"
  ADD CONSTRAINT "order_lines_commission_standard_rate_check" CHECK (
    "commission_standard_rate_bps" IS NULL
    OR ("commission_rate_reason" = 'exclusive'
      AND "commission_rate_bps" IS NOT NULL
      AND "commission_standard_rate_bps" >= "commission_rate_bps"
      AND "commission_standard_rate_bps" <= 3000)) NOT VALID;
ALTER TABLE "ordering"."order_lines" VALIDATE CONSTRAINT "order_lines_commission_standard_rate_check";

-- Grants: unchanged. The app role inserts lines (table-level INSERT) and never updates this.
