-- Reverses 20261105030000_catalog_category_edit_support (docs/design/data/catalog.md 8.3).
-- Development and CI only: the cascade markers are lost.
REVOKE UPDATE ("slug", "hidden_by_id") ON TABLE "catalog"."platform_categories" FROM "mondapac_app";
ALTER TABLE "catalog"."platform_categories"
  DROP CONSTRAINT "platform_categories_market_id_hidden_by_id_fkey",
  DROP CONSTRAINT "platform_categories_hidden_by_check";
ALTER TABLE "catalog"."platform_category_revision_texts"
  DROP CONSTRAINT "platform_category_revision_texts_keywords_ndims_check";
ALTER TABLE "catalog"."platform_categories" DROP COLUMN "hidden_by_id";
