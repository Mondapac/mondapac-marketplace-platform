-- Reverses 20261028120000_catalog_brand. Drops the brand entity with its aliases and merge queue
-- and the products.brand_id column: the brands, aliases, queue decisions and every product's
-- brand_id are lost. The `brand` attribute values in the revisions are untouched, so running the
-- migration again rebuilds the backfilled brands (not an admin's edits to them).
SET lock_timeout = '5s';
SET statement_timeout = '60s';

REVOKE UPDATE ("brand_id") ON TABLE "catalog"."products" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "resolution", "resolved_at", "resolved_by")
  ON TABLE "catalog"."brand_merge_candidates" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("brand_id") ON TABLE "catalog"."brand_aliases" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("slug", "name", "name_key", "logo_image_id", "logo_alt", "header_image_id",
  "summary", "origin_country", "status", "approved_by", "merged_into_id", "updated_at", "version")
  ON TABLE "catalog"."brands" FROM "mondapac_app";

DROP TRIGGER "products_brand_exists" ON "catalog"."products";
DROP FUNCTION "catalog"."products_brand_exists"();
DROP TRIGGER "brands_no_delete" ON "catalog"."brands";
DROP TRIGGER "brands_no_truncate" ON "catalog"."brands";
DROP INDEX "catalog"."products_market_id_brand_id_idx";
ALTER TABLE "catalog"."products" DROP COLUMN "brand_id";

DROP TABLE "catalog"."brand_merge_candidates";
DROP TABLE "catalog"."brand_aliases";
DROP TABLE "catalog"."brands";
