SET lock_timeout = '5s';
-- Catalog: product photos in WebP and AVIF besides JPEG (SEO package 6B-2, package 1).
--
-- A rendition row now has a format: `format_code` is 'jpeg' (every existing row, by the default),
-- 'webp' or 'avif', and the key of a row is (market, image, size, format). The size CHECK stays
-- (thumb, medium, large). The JPEG object keys do not change; a WebP or AVIF file is
-- `<product>/<image>/<size>-webp` or `-avif` (an object key has no dot). No new table, no new grant: the application role
-- keeps SELECT and INSERT on the table, so a rendition row is still insert-only.

ALTER TABLE "catalog"."product_image_renditions"
  ADD COLUMN "format_code" TEXT NOT NULL DEFAULT 'jpeg';

ALTER TABLE "catalog"."product_image_renditions"
  DROP CONSTRAINT "product_image_renditions_pkey",
  ADD CONSTRAINT "product_image_renditions_pkey" PRIMARY KEY ("market_id","image_id","size_code","format_code"),
  ADD CONSTRAINT "product_image_renditions_format_code_check" CHECK ("format_code" IN ('jpeg', 'webp', 'avif'));
