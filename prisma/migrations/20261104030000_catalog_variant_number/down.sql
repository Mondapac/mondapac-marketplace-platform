-- Reverses 20261104030000_catalog_variant_number: the guard goes back to its earlier body (without
-- the number), then the constraints, the index and the column. Variant codes are derived, so no
-- other data is lost.
CREATE OR REPLACE FUNCTION "catalog"."product_variants_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE p_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.product_variants: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.market_id, NEW.tenant_id, NEW.product_id, NEW.variant_model, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.tenant_id, OLD.product_id, OLD.variant_model, OLD.created_at) THEN
    RAISE EXCEPTION 'catalog.product_variants: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state = 'retired' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'catalog.product_variants: a retired variant never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (OLD.state = NEW.state
          OR (OLD.state = 'proposed' AND NEW.state IN ('published', 'retired'))
          OR (OLD.state = 'published' AND NEW.state = 'retired')) THEN
    RAISE EXCEPTION 'catalog.product_variants: transition % to % is not allowed', OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state = 'retired' AND OLD.state <> 'retired' AND NEW.variant_model = 'single' THEN
    SELECT p.status INTO p_status FROM "catalog"."products" p
     WHERE p.market_id = NEW.market_id AND p.id = NEW.product_id;
    IF p_status IS DISTINCT FROM 'discarded' THEN
      RAISE EXCEPTION 'catalog.product_variants: a single variant is retired only with a discarded product'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
ALTER TABLE "catalog"."product_variants" DROP CONSTRAINT "product_variants_single_no_check";
DROP INDEX "catalog"."product_variants_market_id_product_id_variant_no_key";
ALTER TABLE "catalog"."product_variants" DROP CONSTRAINT "product_variants_variant_no_check";
ALTER TABLE "catalog"."product_variants" DROP COLUMN "variant_no";
