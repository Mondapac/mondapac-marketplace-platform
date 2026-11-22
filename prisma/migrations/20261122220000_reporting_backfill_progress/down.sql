-- Reverses 20261122220000_reporting_backfill_progress. The backfill starts again from the beginning
-- once the migration is applied again; every write it makes replaces, so that is harmless.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("after", "pages", "failed_facts", "updated_at", "finished_at")
  ON TABLE "reporting"."backfill_progress" FROM "mondapac_app";
DROP TABLE "reporting"."backfill_progress";
