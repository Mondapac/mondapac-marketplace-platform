-- Reverses 20261031020000_catalog_platform_import (docs/design/data/catalog.md 8.3). The import
-- jobs and their row results go with the tables: a development rollback. The products an import
-- created are products and stay; the stored files are not reachable once the jobs are gone, so
-- run the purge job (`catalog.purge-platform-imports`) before rolling back in an environment that
-- has uploads.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, DELETE, UPDATE ("run_state", "run_code", "product_id", "product_code")
  ON TABLE "catalog"."platform_import_rows" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE,
  UPDATE ("state", "file_deleted_at", "start_as", "skip_errors", "to_import", "added_rows",
    "failed_rows", "stop_reason", "not_before", "lease_until", "version", "started_at", "finished_at")
  ON TABLE "catalog"."platform_import_jobs" FROM "mondapac_app";

-- The three admin counter kinds go back out of the list: their counters are deleted first, so the
-- older CHECK holds for every remaining row.
DELETE FROM "catalog"."rate_counters"
  WHERE "kind" IN ('platform-import-check.account.hour', 'platform-import-check.account.day',
    'platform-import-start.account.day');
ALTER TABLE "catalog"."rate_counters" DROP CONSTRAINT "rate_counters_kind_check";
ALTER TABLE "catalog"."rate_counters"
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN (
    'draft-save.account.minute', 'draft-save.account.day',
    'claim-text-check.account.minute', 'claim-text-check.account.day',
    'submit.seller.hour', 'photo-upload.seller.day', 'search.account.minute',
    'import-start.seller.day', 'ai-suggest.seller.day', 'reviewer-mail.market.hour'));

DROP TABLE "catalog"."platform_import_rows";
DROP TABLE "catalog"."platform_import_jobs";
