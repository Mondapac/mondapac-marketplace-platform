-- Reverses 20261104233000_catalog_variant_fields. A revision that carries the reason `gtin-changed`
-- keeps its other reasons; the per-variant values (GTIN, shipping, picks) are dropped with their columns.
ALTER TABLE "catalog"."product_revisions" DISABLE TRIGGER USER;
UPDATE "catalog"."product_revisions"
   SET "sensitive_reasons" = array_remove("sensitive_reasons", 'gtin-changed')
 WHERE 'gtin-changed' = ANY("sensitive_reasons");
ALTER TABLE "catalog"."product_revisions" ENABLE TRIGGER USER;
ALTER TABLE "catalog"."product_revisions" DROP CONSTRAINT "product_revisions_sensitive_reasons_check";
ALTER TABLE "catalog"."product_revisions"
  ADD CONSTRAINT "product_revisions_sensitive_reasons_check" CHECK (
    "sensitive_reasons" IS NOT NULL AND array_position("sensitive_reasons", NULL) IS NULL
    AND "sensitive_reasons" <@ ARRAY[
    'platform-categories', 'tax-category', 'name', 'primary-image', 'image-added-or-replaced',
    'variant-removed', 'never-published', 'approval-required']::text[]);

DROP TRIGGER "product_revision_variants_image_picks" ON "catalog"."product_revision_variants";
DROP FUNCTION "catalog"."product_revision_variants_image_picks"();
DROP INDEX "catalog"."product_revision_variants_market_id_gtin_idx";
ALTER TABLE "catalog"."product_revision_variants"
  DROP CONSTRAINT "product_revision_variants_image_ids_check",
  DROP CONSTRAINT "product_revision_variants_dimensions_check",
  DROP CONSTRAINT "product_revision_variants_weight_check",
  DROP CONSTRAINT "product_revision_variants_gtin_check",
  DROP COLUMN "image_ids",
  DROP COLUMN "shipping_height_mm",
  DROP COLUMN "shipping_width_mm",
  DROP COLUMN "shipping_length_mm",
  DROP COLUMN "shipping_weight_grams",
  DROP COLUMN "gtin";
