SET lock_timeout = '5s';

ALTER TABLE "commission_payouts"."ledger_entries" DROP CONSTRAINT "ledger_entries_exclusive_saving_check";
ALTER TABLE "commission_payouts"."ledger_entries"
  DROP COLUMN "saved_amount",
  DROP COLUMN "standard_rate_bps";
