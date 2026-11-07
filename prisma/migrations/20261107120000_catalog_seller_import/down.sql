-- Reverses 20261107120000_catalog_seller_import (docs/design/data/catalog.md 8.3). The import jobs,
-- their row results and photo records go with the tables: a development rollback. The products,
-- Offers and photos an import created are ordinary rows and stay; the stored files are not
-- reachable once the jobs are gone, so run the purge job (`catalog.purge-seller-imports`) before
-- rolling back in an environment that has uploads.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, DELETE ON TABLE "catalog"."seller_import_photos" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE, UPDATE ("run_state", "run_code", "product_id", "offer_id", "product_code")
  ON TABLE "catalog"."seller_import_rows" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE,
  UPDATE ("state", "file_deleted_at", "skip_errors", "to_import", "created_rows", "updated_rows",
    "unchanged_rows", "failed_rows", "stop_reason", "not_before", "lease_until", "version",
    "started_at", "finished_at")
  ON TABLE "catalog"."seller_import_jobs" FROM "mondapac_app";

-- The four seller counter kinds go back out of the list: their counters are deleted first, so the
-- older CHECK holds for every remaining row.
DELETE FROM "catalog"."rate_counters"
  WHERE "kind" IN ('seller-import-check.seller.hour', 'seller-import-check.seller.day',
    'import-photo.seller.minute', 'import-photo.seller.day');
ALTER TABLE "catalog"."rate_counters" DROP CONSTRAINT "rate_counters_kind_check";
ALTER TABLE "catalog"."rate_counters"
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN (
    'draft-save.account.minute', 'draft-save.account.day',
    'claim-text-check.account.minute', 'claim-text-check.account.day',
    'submit.seller.hour', 'photo-upload.seller.day', 'search.account.minute',
    'import-start.seller.day', 'ai-suggest.seller.day', 'reviewer-mail.market.hour',
    'platform-import-check.account.hour', 'platform-import-check.account.day',
    'platform-import-start.account.day'));

DROP TABLE "catalog"."seller_import_photos";
DROP TABLE "catalog"."seller_import_rows";
DROP TABLE "catalog"."seller_import_jobs";
