-- Variant number per product (variants management V2, plan section 6, decision t12): 1, 2, 3 ...
-- in creation order, minted by the server, never reused (a retired variant keeps its number) and
-- immutable. The variant code `{productCode}-{nn}` is derived from it, not stored.

ALTER TABLE "catalog"."product_variants" ADD COLUMN "variant_no" INTEGER;

-- Backfill in creation order (created_at, then id). The guard trigger refuses any change to a
-- retired row, so it is off for this one statement; the migrator owns the table.
ALTER TABLE "catalog"."product_variants" DISABLE TRIGGER "product_variants_guard";
UPDATE "catalog"."product_variants" v
   SET "variant_no" = n."variant_no"
  FROM (
    SELECT "id", (ROW_NUMBER() OVER (
             PARTITION BY "market_id", "product_id" ORDER BY "created_at", "id"))::integer AS "variant_no"
      FROM "catalog"."product_variants"
  ) n
 WHERE v."id" = n."id";
ALTER TABLE "catalog"."product_variants" ENABLE TRIGGER "product_variants_guard";

ALTER TABLE "catalog"."product_variants" ALTER COLUMN "variant_no" SET NOT NULL;
ALTER TABLE "catalog"."product_variants"
  ADD CONSTRAINT "product_variants_variant_no_check" CHECK ("variant_no" >= 1);

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_market_id_product_id_variant_no_key"
  ON "catalog"."product_variants"("market_id", "product_id", "variant_no");

-- A Simple product's one variant is number 1.
ALTER TABLE "catalog"."product_variants"
  ADD CONSTRAINT "product_variants_single_no_check" CHECK ("variant_model" <> 'single' OR "variant_no" = 1);

-- The guard now also refuses a change of the number (hand-written; same body as before plus the column).
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
