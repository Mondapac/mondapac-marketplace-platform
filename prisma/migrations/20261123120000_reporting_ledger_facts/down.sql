-- Reverses 20261123120000_reporting_ledger_facts. The ledger facts and their rollup are lost; they
-- are derived data, read again by the ledger history backfill once the migration is applied again
-- (its progress row is removed here, so it starts from the beginning).
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, DELETE ON TABLE "reporting"."daily_ledger" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "reporting"."ledger_entries" FROM "mondapac_app";

DELETE FROM "reporting"."backfill_progress" WHERE "kind" = 'ledger';
ALTER TABLE "reporting"."backfill_progress"
  DROP CONSTRAINT "backfill_progress_kind_check",
  ADD CONSTRAINT "backfill_progress_kind_check" CHECK ("kind" IN ('seller-orders', 'refunds'));

DROP TABLE "reporting"."daily_ledger";
DROP TABLE "reporting"."ledger_entries";
