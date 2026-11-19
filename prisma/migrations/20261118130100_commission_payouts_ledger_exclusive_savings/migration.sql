-- Customers management phase 4b follow-up: what a seller saved on its exclusive customers. A
-- `commission` row of a line whose rate was lowered keeps the rate the line would have carried
-- (`standard_rate_bps`) and the commission not taken (`saved_amount`: the commission at that rate
-- on the same base less the row's amount); its `refund-commission` rows keep the part of the saving
-- they give back. Both columns are null on every other row. Nullable, no default: no row is
-- rewritten (the ledger is insert-only; ALTER TABLE adds a column without touching rows).
SET lock_timeout = '5s';

ALTER TABLE "commission_payouts"."ledger_entries"
  ADD COLUMN "standard_rate_bps" INTEGER,
  ADD COLUMN "saved_amount" BIGINT;

-- Hand-written: both or neither, on the commission kinds only, never below the row's rate, in
-- the range of every rate (0 to 3000) and never negative. On a `commission` row the commission at
-- the standard rate (amount + saving) never exceeds the base; a reversal's parts are rounded on
-- their own, so that bound is left to the original row. Added NOT VALID and then validated: every
-- existing row is null and passes (in one transaction, so the validation still holds the lock of
-- the ADD; accepted while the table is small).
ALTER TABLE "commission_payouts"."ledger_entries"
  ADD CONSTRAINT "ledger_entries_exclusive_saving_check" CHECK (
    ("standard_rate_bps" IS NULL AND "saved_amount" IS NULL)
    OR ("kind" IN ('commission', 'refund-commission')
      AND "standard_rate_bps" IS NOT NULL
      AND "saved_amount" IS NOT NULL
      AND "rate_bps" IS NOT NULL
      AND "standard_rate_bps" >= "rate_bps"
      AND "standard_rate_bps" <= 3000
      AND "saved_amount" >= 0
      AND ("kind" <> 'commission' OR "amount" + "saved_amount" <= "base_amount"))) NOT VALID;
ALTER TABLE "commission_payouts"."ledger_entries" VALIDATE CONSTRAINT "ledger_entries_exclusive_saving_check";

-- The partial index of the seller's savings is in 20261118130200 (CONCURRENTLY, alone in its file).

-- Grants: unchanged (SELECT, INSERT on the table; the ledger is never updated).
