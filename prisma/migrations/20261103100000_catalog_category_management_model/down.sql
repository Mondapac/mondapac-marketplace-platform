-- Reverses 20261103100000_catalog_category_management_model (docs/design/data/catalog.md 8.3):
-- grants first, then triggers, the new tables, the new columns and constraints, the functions.
-- Development and CI only: the dropped columns and tables lose their data.
REVOKE SELECT, INSERT ON TABLE "catalog"."platform_category_slug_history" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "catalog"."platform_category_revision_texts" FROM "mondapac_app";
REVOKE UPDATE ("position", "show_in_menu", "image_id", "seo_title", "seo_description", "seo_noindex")
  ON TABLE "catalog"."platform_categories" FROM "mondapac_app";

DROP INDEX "catalog"."product_revision_categories_market_id_revision_id_primary_key";
ALTER TABLE "catalog"."product_revision_categories" DROP COLUMN "is_primary";

DROP TRIGGER "platform_categories_slug_not_recently_retired" ON "catalog"."platform_categories";
DROP TABLE "catalog"."platform_category_slug_history";
DROP FUNCTION "catalog"."platform_categories_slug_not_recently_retired"();

DROP TRIGGER "platform_category_revision_names_copy_to_texts" ON "catalog"."platform_category_revision_names";
DROP FUNCTION "catalog"."platform_category_names_copy_to_texts"();
DROP TABLE "catalog"."platform_category_revision_texts";

-- Rows written with a new kind or status cannot go back: development and CI hold none by design,
-- and a database that does fails here instead of losing them silently.
ALTER TABLE "catalog"."platform_category_revisions"
  DROP CONSTRAINT "platform_category_revisions_reason_check",
  DROP CONSTRAINT "platform_category_revisions_change_kind_check";
ALTER TABLE "catalog"."platform_category_revisions" DROP COLUMN "reason";
ALTER TABLE "catalog"."platform_category_revisions"
  ADD CONSTRAINT "platform_category_revisions_change_kind_check" CHECK (
    "change_kind" IN ('created', 'renamed', 'moved', 'merged', 'archived'));

DROP TRIGGER "platform_categories_default_position" ON "catalog"."platform_categories";
DROP FUNCTION "catalog"."platform_categories_default_position"();
ALTER TABLE "catalog"."platform_categories"
  DROP CONSTRAINT "platform_categories_market_id_parent_id_position_key",
  DROP CONSTRAINT "platform_categories_status_check";
ALTER TABLE "catalog"."platform_categories"
  ADD CONSTRAINT "platform_categories_status_check" CHECK ("status" IN ('active', 'merged', 'archived'));
ALTER TABLE "catalog"."platform_categories"
  DROP COLUMN "seo_noindex",
  DROP COLUMN "seo_description",
  DROP COLUMN "seo_title",
  DROP COLUMN "image_id",
  DROP COLUMN "show_in_menu",
  DROP COLUMN "position";
