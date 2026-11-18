SET lock_timeout = '5s';

DROP INDEX "commission_payouts"."ledger_entries_seller_savings_idx";
ALTER TABLE "commission_payouts"."ledger_entries" DROP CONSTRAINT "ledger_entries_exclusive_saving_check";
ALTER TABLE "commission_payouts"."ledger_entries"
  DROP COLUMN "saved_amount",
  DROP COLUMN "standard_rate_bps";
