-- Reverses 20261111100000_catalog_move_products_job. The jobs and their items go with the tables: a
-- development rollback. A `category-override` revision cannot be removed (products point at it and
-- revisions are insert-only), so the rollback refuses while one exists instead of failing half-way.
SET lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "catalog"."product_revisions" WHERE "revision_kind" = 'category-override') THEN
    RAISE EXCEPTION 'category-override revisions exist; this migration cannot be rolled back';
  END IF;
END
$$;

REVOKE SELECT, INSERT, UPDATE ("state", "revision_id", "seller_notified_at")
  ON TABLE "catalog"."category_product_move_items" FROM "mondapac_app";
REVOKE SELECT, INSERT,
  UPDATE ("state", "started_at", "finished_at", "cursor_product_id", "total_count", "moved_count",
    "skipped_count", "failed_count", "lease_holder", "lease_expires_at", "version")
  ON TABLE "catalog"."category_product_move_jobs" FROM "mondapac_app";

DROP TABLE "catalog"."category_product_move_items";
DROP TABLE "catalog"."category_product_move_jobs";

-- The kind list goes back to its three kinds; no row holds the fourth (checked above).
ALTER TABLE "catalog"."product_revisions"
  DROP CONSTRAINT "product_revisions_category_override_author_check",
  DROP CONSTRAINT "product_revisions_category_override_base_check",
  DROP CONSTRAINT "product_revisions_kind_check";
ALTER TABLE "catalog"."product_revisions"
  ADD CONSTRAINT "product_revisions_kind_check" CHECK (
    "revision_kind" IN ('submission', 'revert', 'tax-override')) NOT VALID;
ALTER TABLE "catalog"."product_revisions" VALIDATE CONSTRAINT "product_revisions_kind_check";
