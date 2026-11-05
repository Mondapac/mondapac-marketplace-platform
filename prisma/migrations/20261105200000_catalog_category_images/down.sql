-- Reverses 20261105200000_catalog_category_images (docs/design/data/catalog.md 8.3).
-- Development and CI only: the category images are lost (their files stay in the object store).
REVOKE SELECT, INSERT ON TABLE "catalog"."category_image_renditions" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "catalog"."category_images" FROM "mondapac_app";
UPDATE "catalog"."platform_categories" SET "image_id" = NULL WHERE "image_id" IS NOT NULL;
ALTER TABLE "catalog"."platform_categories"
  DROP CONSTRAINT "platform_categories_market_id_image_id_id_fkey";
DROP TABLE "catalog"."category_image_renditions";
DROP TABLE "catalog"."category_images";
