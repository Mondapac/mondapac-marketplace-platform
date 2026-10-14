-- Reverses 20261014120000_catalog_product_images: grants, triggers, then the tables, children
-- before parents. CHECKs, indexes and foreign keys go with their tables.
REVOKE SELECT, INSERT ON TABLE "catalog"."product_revision_images" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "catalog"."product_image_renditions" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "catalog"."product_images" FROM "mondapac_app";
DROP TRIGGER "product_revision_images_no_truncate" ON "catalog"."product_revision_images";
DROP TRIGGER "product_revision_images_no_update_delete" ON "catalog"."product_revision_images";
DROP TRIGGER "product_revision_images_clean" ON "catalog"."product_revision_images";
DROP FUNCTION "catalog"."product_revision_images_clean"();
DROP TABLE "catalog"."product_revision_images";
DROP TABLE "catalog"."product_image_renditions";
DROP TABLE "catalog"."product_images";
