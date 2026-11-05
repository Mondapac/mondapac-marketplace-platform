SET lock_timeout = '5s';
-- Catalog: a product's feature set follows its primary category (attributes plan A4, decision
-- ت۱۰; CAT-10 changes from "never changes" to "changes only with a revision pointer").
--
-- `products.family_code` becomes updatable by the application role, but only in the same UPDATE
-- that moves `pending_revision_id` or `published_revision_id` (a submit, an approval, a reject or
-- a withdraw): the guard below refuses any other change. `type_code` stays immutable. The column
-- itself, its CHECK and every row are untouched. The database does not check that the new value
-- is the family of the primary category: the application owns that rule.

GRANT UPDATE ("family_code") ON TABLE "catalog"."products" TO "mondapac_app";

CREATE FUNCTION "catalog"."products_family_follows_revision"() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."family_code" IS DISTINCT FROM OLD."family_code"
     AND NEW."pending_revision_id" IS NOT DISTINCT FROM OLD."pending_revision_id"
     AND NEW."published_revision_id" IS NOT DISTINCT FROM OLD."published_revision_id" THEN
    RAISE EXCEPTION 'catalog.products: the family changes only with a revision pointer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "products_family_follows_revision" BEFORE UPDATE OF "family_code"
  ON "catalog"."products"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."products_family_follows_revision"();
