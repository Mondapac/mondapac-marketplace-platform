SET lock_timeout = '5s';
-- Catalog: Add sizes, a Simple product becomes Configurable once, never back (variants V9;
-- catalog design 2.3 M-9, 4.2a; data design 3.1, 3.2, 3.7; CAT-10 changes from "never changes").
--
-- 1. `products.type_code` and `variant_model` become updatable by the application role, but only
--    together and only from `simple`/`single` to `configurable`/`options` (trigger below). The
--    rest of the row, its CHECKs and every existing row are untouched.
-- 2. The variant foreign key cascades the change to the variant row (ON UPDATE CASCADE), and the
--    variant guard lets `variant_model` change only from `single` to `options`.
-- 3. Every revision records the type it was frozen with (`product_revisions.type_code`); every
--    existing product is still of its creation type, so the backfill reads the product row.
-- 4. The review reasons gain `axis-added`; the rate-counter kinds gain the Add sizes limit.

-- 1. Grant and guard.
GRANT UPDATE ("type_code", "variant_model") ON TABLE "catalog"."products" TO "mondapac_app";

CREATE FUNCTION "catalog"."products_type_change_guard"() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW."type_code", NEW."variant_model") IS DISTINCT FROM (OLD."type_code", OLD."variant_model")
     AND NOT (OLD."type_code" = 'simple' AND OLD."variant_model" = 'single'
              AND NEW."type_code" = 'configurable' AND NEW."variant_model" = 'options') THEN
    RAISE EXCEPTION 'catalog.products: the type changes only from simple to configurable, together with the variant model'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "products_type_change_guard" BEFORE UPDATE OF "type_code", "variant_model"
  ON "catalog"."products"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."products_type_change_guard"();

-- 2. The foreign key cascades the variant model; the variant guard allows only single -> options.
ALTER TABLE "catalog"."product_variants"
  DROP CONSTRAINT "product_variants_market_id_product_id_variant_model_fkey";
ALTER TABLE "catalog"."product_variants"
  ADD CONSTRAINT "product_variants_market_id_product_id_variant_model_fkey"
  FOREIGN KEY ("market_id", "product_id", "variant_model")
  REFERENCES "catalog"."products"("market_id", "id", "variant_model")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "catalog"."product_variants"
  VALIDATE CONSTRAINT "product_variants_market_id_product_id_variant_model_fkey";

-- Hand-written; same body as 20261104030000_catalog_variant_number except that `variant_model`
-- leaves the immutable tuple and gets its own rule (single -> options, the cascade of Add sizes).
CREATE OR REPLACE FUNCTION "catalog"."product_variants_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE p_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.product_variants: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.market_id, NEW.tenant_id, NEW.product_id, NEW.created_at, NEW.variant_no)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.tenant_id, OLD.product_id, OLD.created_at, OLD.variant_no) THEN
    RAISE EXCEPTION 'catalog.product_variants: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.variant_model IS DISTINCT FROM OLD.variant_model
     AND NOT (OLD.variant_model = 'single' AND NEW.variant_model = 'options') THEN
    RAISE EXCEPTION 'catalog.product_variants: the variant model changes only from single to options'
      USING ERRCODE = 'restrict_violation';
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

-- 3. The type a revision was frozen with. The revision tables are insert-only (a trigger refuses
-- any update), so it is off for the one backfill statement; the migrator owns the table.
ALTER TABLE "catalog"."product_revisions" ADD COLUMN "type_code" TEXT;

ALTER TABLE "catalog"."product_revisions" DISABLE TRIGGER "product_revisions_no_update_delete";
UPDATE "catalog"."product_revisions" r
   SET "type_code" = p."type_code"
  FROM "catalog"."products" p
 WHERE p."market_id" = r."market_id" AND p."id" = r."product_id";
ALTER TABLE "catalog"."product_revisions" ENABLE TRIGGER "product_revisions_no_update_delete";

ALTER TABLE "catalog"."product_revisions" ALTER COLUMN "type_code" SET NOT NULL;
ALTER TABLE "catalog"."product_revisions"
  ADD CONSTRAINT "product_revisions_type_code_check" CHECK ("type_code" ~ '^[a-z][a-z0-9_-]{0,63}$') NOT VALID;
ALTER TABLE "catalog"."product_revisions" VALIDATE CONSTRAINT "product_revisions_type_code_check";

-- 4. A second axis added by a submit joins the review reasons (D 9.2a); every earlier code stays.
ALTER TABLE "catalog"."product_revisions" DROP CONSTRAINT "product_revisions_sensitive_reasons_check";
ALTER TABLE "catalog"."product_revisions"
  ADD CONSTRAINT "product_revisions_sensitive_reasons_check" CHECK (
    "sensitive_reasons" IS NOT NULL AND array_position("sensitive_reasons", NULL) IS NULL
    AND "sensitive_reasons" <@ ARRAY[
    'platform-categories', 'tax-category', 'name', 'primary-image', 'image-added-or-replaced',
    'variant-removed', 'gtin-changed', 'axis-added', 'never-published', 'approval-required']::text[]) NOT VALID;
ALTER TABLE "catalog"."product_revisions" VALIDATE CONSTRAINT "product_revisions_sensitive_reasons_check";

-- The Add sizes limit: 20 per account per hour (catalog design 8.4). The kind list is a CHECK,
-- so a new kind is this widening (data design 3.26).
ALTER TABLE "catalog"."rate_counters" DROP CONSTRAINT "rate_counters_kind_check";
ALTER TABLE "catalog"."rate_counters"
  ADD CONSTRAINT "rate_counters_kind_check" CHECK ("kind" IN (
    'draft-save.account.minute', 'draft-save.account.day',
    'claim-text-check.account.minute', 'claim-text-check.account.day',
    'submit.seller.hour', 'photo-upload.seller.day', 'search.account.minute',
    'import-start.seller.day', 'ai-suggest.seller.day', 'reviewer-mail.market.hour',
    'platform-import-check.account.hour', 'platform-import-check.account.day',
    'platform-import-start.account.day', 'add-sizes.account.hour'));
