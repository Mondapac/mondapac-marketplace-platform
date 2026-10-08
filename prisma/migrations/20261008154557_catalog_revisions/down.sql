-- Reverses 20261008154557_catalog_revisions (docs/design/data/catalog.md 8.3): the grants first,
-- then the triggers, then the pointer foreign keys, constraints, indexes and columns added to
-- `products`, then the tables, children before parents. The insert-only triggers do not fire on
-- DROP TABLE. CHECKs and indexes of the new tables go with their tables.
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "catalog"."rate_counters" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "catalog"."product_revision_decisions" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "catalog"."product_revision_variants" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "catalog"."product_revision_categories" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "catalog"."product_revision_texts" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "catalog"."product_revisions" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "catalog"."product_working_copies" FROM "mondapac_app";
REVOKE UPDATE ("published_revision_id", "pending_revision_id", "pending_submitted_at")
  ON TABLE "catalog"."products" FROM "mondapac_app";
DROP TRIGGER "product_revision_decisions_no_truncate" ON "catalog"."product_revision_decisions";
DROP TRIGGER "product_revision_decisions_no_update_delete" ON "catalog"."product_revision_decisions";
DROP TRIGGER "product_revision_variants_no_truncate" ON "catalog"."product_revision_variants";
DROP TRIGGER "product_revision_variants_no_update_delete" ON "catalog"."product_revision_variants";
DROP TRIGGER "product_revision_categories_no_truncate" ON "catalog"."product_revision_categories";
DROP TRIGGER "product_revision_categories_no_update_delete" ON "catalog"."product_revision_categories";
DROP TRIGGER "product_revision_texts_no_truncate" ON "catalog"."product_revision_texts";
DROP TRIGGER "product_revision_texts_no_update_delete" ON "catalog"."product_revision_texts";
DROP TRIGGER "product_revisions_no_truncate" ON "catalog"."product_revisions";
DROP TRIGGER "product_revisions_no_update_delete" ON "catalog"."product_revisions";
DROP TRIGGER "product_revision_variants_not_retired" ON "catalog"."product_revision_variants";
DROP FUNCTION "catalog"."product_revision_variants_not_retired"();
DROP INDEX "catalog"."products_market_id_pending_submitted_at_idx";
DROP INDEX "catalog"."products_market_id_owner_seller_id_created_at_idx";
DROP INDEX "catalog"."products_market_id_published_revision_id_key";
ALTER TABLE "catalog"."products"
  DROP CONSTRAINT "products_discarded_revision_check",
  DROP CONSTRAINT "products_pending_submitted_check",
  DROP CONSTRAINT "products_pending_revision_check",
  DROP CONSTRAINT "products_published_revision_check",
  DROP CONSTRAINT "products_market_id_id_pending_revision_id_fkey",
  DROP CONSTRAINT "products_market_id_id_published_revision_id_fkey";
ALTER TABLE "catalog"."products"
  DROP COLUMN "pending_submitted_at",
  DROP COLUMN "pending_revision_id",
  DROP COLUMN "published_revision_id";
DROP TABLE "catalog"."rate_counters";
DROP TABLE "catalog"."product_revision_decisions";
DROP TABLE "catalog"."product_revision_variants";
DROP TABLE "catalog"."product_revision_categories";
DROP TABLE "catalog"."product_revision_texts";
DROP TABLE "catalog"."product_working_copies";
DROP TABLE "catalog"."product_revisions";
