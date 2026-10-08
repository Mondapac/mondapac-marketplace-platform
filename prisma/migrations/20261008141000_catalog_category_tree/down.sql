-- Reverses 20261008141000_catalog_category_tree (docs/design/data/catalog.md 8.3): the grants
-- first, then the triggers and the function, then the tables, children before parents. CHECKs,
-- indexes and foreign keys go with their tables. The two tables point at each other (revision to
-- category, category to published revision), so the second foreign key is dropped first.
REVOKE SELECT, INSERT ON TABLE "catalog"."platform_category_revision_names" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "catalog"."platform_category_revisions" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("parent_id", "status", "merged_into_id", "published_revision_id", "version")
  ON TABLE "catalog"."platform_categories" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("version") ON TABLE "catalog"."category_trees" FROM "mondapac_app";
DROP TRIGGER "platform_categories_no_cycle" ON "catalog"."platform_categories";
DROP TRIGGER "platform_category_revision_names_no_truncate" ON "catalog"."platform_category_revision_names";
DROP TRIGGER "platform_category_revision_names_no_update_delete" ON "catalog"."platform_category_revision_names";
DROP TRIGGER "platform_category_revisions_no_truncate" ON "catalog"."platform_category_revisions";
DROP TRIGGER "platform_category_revisions_no_update_delete" ON "catalog"."platform_category_revisions";
DROP TABLE "catalog"."platform_category_revision_names";
ALTER TABLE "catalog"."platform_categories"
  DROP CONSTRAINT "platform_categories_market_id_id_published_revision_id_fkey";
DROP TABLE "catalog"."platform_category_revisions";
DROP TABLE "catalog"."platform_categories";
DROP TABLE "catalog"."category_trees";
DROP FUNCTION "catalog"."platform_categories_no_cycle"();
