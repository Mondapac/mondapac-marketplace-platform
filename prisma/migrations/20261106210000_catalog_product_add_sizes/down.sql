SET lock_timeout = '5s';
-- Reverses 20261106210000_catalog_product_add_sizes. A product that was changed to Configurable
-- stays Configurable (its variant row keeps `options` too, so the foreign key still holds); only
-- the right to change a type is taken away. The revision tables are insert-only, so a revision that
-- carries the reason `axis-added` is not rewritten: the reversal refuses while one exists.
DELETE FROM "catalog"."rate_counters" WHERE "kind" = 'add-sizes.account.hour';
ALTER TABLE "catalog"."rate_counters" DROP CONSTRAINT "rate_counters_kind_check";
ALTER TABLE "catalog"."rate_counters"
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN (
    'draft-save.account.minute', 'draft-save.account.day',
    'claim-text-check.account.minute', 'claim-text-check.account.day',
    'submit.seller.hour', 'photo-upload.seller.day', 'search.account.minute',
    'import-start.seller.day', 'ai-suggest.seller.day', 'reviewer-mail.market.hour',
    'platform-import-check.account.hour', 'platform-import-check.account.day',
    'platform-import-start.account.day'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "catalog"."product_revisions" WHERE 'axis-added' = ANY("sensitive_reasons")) THEN
    RAISE EXCEPTION 'cannot reverse add_sizes: product_revisions rows with the reason axis-added exist (insert-only table)'
      USING ERRCODE = '23514';
  END IF;
END $$;
ALTER TABLE "catalog"."product_revisions" DROP CONSTRAINT "product_revisions_sensitive_reasons_check";
ALTER TABLE "catalog"."product_revisions"
  ADD CONSTRAINT "product_revisions_sensitive_reasons_check" CHECK (
    "sensitive_reasons" IS NOT NULL AND array_position("sensitive_reasons", NULL) IS NULL
    AND "sensitive_reasons" <@ ARRAY[
    'platform-categories', 'tax-category', 'name', 'primary-image', 'image-added-or-replaced',
    'variant-removed', 'gtin-changed', 'never-published', 'approval-required']::text[]);

ALTER TABLE "catalog"."product_revisions" DROP CONSTRAINT "product_revisions_type_code_check";
ALTER TABLE "catalog"."product_revisions" DROP COLUMN "type_code";

-- The variant guard goes back to the body of 20261104030000_catalog_variant_number.
CREATE OR REPLACE FUNCTION "catalog"."product_variants_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE p_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.product_variants: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.market_id, NEW.tenant_id, NEW.product_id, NEW.variant_model, NEW.created_at, NEW.variant_no)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.tenant_id, OLD.product_id, OLD.variant_model, OLD.created_at, OLD.variant_no) THEN
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

ALTER TABLE "catalog"."product_variants"
  DROP CONSTRAINT "product_variants_market_id_product_id_variant_model_fkey";
ALTER TABLE "catalog"."product_variants"
  ADD CONSTRAINT "product_variants_market_id_product_id_variant_model_fkey"
  FOREIGN KEY ("market_id", "product_id", "variant_model")
  REFERENCES "catalog"."products"("market_id", "id", "variant_model")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "catalog"."product_variants"
  VALIDATE CONSTRAINT "product_variants_market_id_product_id_variant_model_fkey";

DROP TRIGGER "products_type_change_guard" ON "catalog"."products";
DROP FUNCTION "catalog"."products_type_change_guard"();
REVOKE UPDATE ("type_code", "variant_model") ON TABLE "catalog"."products" FROM "mondapac_app";
