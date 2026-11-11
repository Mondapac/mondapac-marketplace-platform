SET lock_timeout = '5s';
-- Reverses 20261111030000_catalog_image_formats. The WebP and AVIF rows are removed (their files
-- stay in the object store until the orphan sweep takes them), then the key is the old one.

DELETE FROM "catalog"."product_image_renditions" WHERE "format_code" <> 'jpeg';

ALTER TABLE "catalog"."product_image_renditions"
  DROP CONSTRAINT "product_image_renditions_format_code_check",
  DROP CONSTRAINT "product_image_renditions_pkey",
  ADD CONSTRAINT "product_image_renditions_pkey" PRIMARY KEY ("market_id","image_id","size_code");

ALTER TABLE "catalog"."product_image_renditions" DROP COLUMN "format_code";
