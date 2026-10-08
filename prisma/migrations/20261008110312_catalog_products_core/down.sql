-- Reverses 20261008110312_catalog_products_core (docs/design/data/catalog.md 8.3): the grants
-- first, in reverse order, then the trigger and its functions, then the tables, children before
-- parents. CHECKs, indexes and foreign keys go with their tables. The empty schema "catalog"
-- stays, without its USAGE grant, as the leftover check of docs/design/data/platform.md 10.5
-- (guard 2) expects.
REVOKE SELECT, INSERT, UPDATE ("next_value") ON TABLE "catalog"."product_code_counters" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("state", "published_at", "retired_at")
  ON TABLE "catalog"."product_variants" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("scope", "owner_seller_id", "status", "discarded_at", "own_brand",
  "matched_into_product_id", "promoted_at", "retired_at", "withdrawn_at", "last_changed_at", "version")
  ON TABLE "catalog"."products" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "catalog"."inbox" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "catalog"."outbox" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "catalog" FROM "mondapac_app";
DROP TRIGGER "product_variants_guard" ON "catalog"."product_variants";
DROP TABLE "catalog"."product_code_counters";
DROP TABLE "catalog"."product_variants";
DROP TABLE "catalog"."products";
DROP TABLE "catalog"."inbox";
DROP TABLE "catalog"."outbox";
DROP FUNCTION "catalog"."product_variants_guard"();
DROP FUNCTION "catalog"."reject_mutation"();
