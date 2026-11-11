-- Per-variant fields (variants management V4, plan decisions t5, t6, t7): an optional GTIN, shipping
-- weight and dimensions, and the variant's picks from the product gallery. The table is insert-only
-- (revisions are frozen), so existing rows keep "no GTIN, product shipping values, no picks".

ALTER TABLE "catalog"."product_revision_variants"
  ADD COLUMN "gtin" VARCHAR(14),
  ADD COLUMN "shipping_weight_grams" INTEGER,
  ADD COLUMN "shipping_length_mm" INTEGER,
  ADD COLUMN "shipping_width_mm" INTEGER,
  ADD COLUMN "shipping_height_mm" INTEGER,
  ADD COLUMN "image_ids" UUID[] NOT NULL DEFAULT ARRAY[]::uuid[];

ALTER TABLE "catalog"."product_revision_variants"
  ADD CONSTRAINT "product_revision_variants_gtin_check" CHECK ("gtin" IS NULL OR "gtin" ~ '^[0-9]{14}$'),
  ADD CONSTRAINT "product_revision_variants_weight_check" CHECK (
    "shipping_weight_grams" IS NULL OR "shipping_weight_grams" BETWEEN 1 AND 1000000),
  ADD CONSTRAINT "product_revision_variants_dimensions_check" CHECK (
    ("shipping_length_mm" IS NULL AND "shipping_width_mm" IS NULL AND "shipping_height_mm" IS NULL)
    -- IS NOT NULL is explicit: a NULL side would make BETWEEN evaluate to NULL, which a CHECK accepts.
    OR ("shipping_length_mm" IS NOT NULL AND "shipping_width_mm" IS NOT NULL
        AND "shipping_height_mm" IS NOT NULL
        AND "shipping_length_mm" BETWEEN 1 AND 100000
        AND "shipping_width_mm" BETWEEN 1 AND 100000
        AND "shipping_height_mm" BETWEEN 1 AND 100000)),
  -- Not NULL by CHECK as well, so the check below cannot evaluate to NULL (the 3.7 pattern).
  ADD CONSTRAINT "product_revision_variants_image_ids_check" CHECK (
    "image_ids" IS NOT NULL AND array_position("image_ids", NULL) IS NULL
    AND cardinality("image_ids") <= 20);

-- The duplicate-GTIN lookup of a draft save: variants of a Market that carry a GTIN (hand-written).
CREATE INDEX "product_revision_variants_market_id_gtin_idx"
  ON "catalog"."product_revision_variants"("market_id", "gtin") WHERE "gtin" IS NOT NULL;

-- The variant's picks are distinct images of the same revision (a subset of its gallery). The
-- repository inserts the revision's images first. SECURITY INVOKER, pinned search_path,
-- schema-qualified names, no dynamic EXECUTE.
CREATE FUNCTION "catalog"."product_revision_variants_image_picks"() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF cardinality(NEW.image_ids) = 0 THEN
    RETURN NEW;
  END IF;
  IF (SELECT count(DISTINCT i) FROM unnest(NEW.image_ids) AS i) <> cardinality(NEW.image_ids) THEN
    RAISE EXCEPTION 'catalog.product_revision_variants: a variant picks an image twice'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.image_ids) AS i
     WHERE NOT EXISTS (
       SELECT 1 FROM "catalog"."product_revision_images" r
        WHERE r.market_id = NEW.market_id AND r.revision_id = NEW.revision_id AND r.image_id = i)
  ) THEN
    RAISE EXCEPTION 'catalog.product_revision_variants: a variant picks an image outside the revision gallery'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "product_revision_variants_image_picks" BEFORE INSERT
  ON "catalog"."product_revision_variants"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."product_revision_variants_image_picks"();

-- A GTIN change joins the review reasons (decision t13).
ALTER TABLE "catalog"."product_revisions" DROP CONSTRAINT "product_revisions_sensitive_reasons_check";
ALTER TABLE "catalog"."product_revisions"
  ADD CONSTRAINT "product_revisions_sensitive_reasons_check" CHECK (
    "sensitive_reasons" IS NOT NULL AND array_position("sensitive_reasons", NULL) IS NULL
    AND "sensitive_reasons" <@ ARRAY[
    'platform-categories', 'tax-category', 'name', 'primary-image', 'image-added-or-replaced',
    'variant-removed', 'gtin-changed', 'never-published', 'approval-required']::text[]);
