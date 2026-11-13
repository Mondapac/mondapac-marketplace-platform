SET lock_timeout = '5s';
-- Reverses 20261105210000_catalog_product_family_follows_category. A product whose family was
-- changed keeps the value it has; only the right to change it again is taken away.
DROP TRIGGER "products_family_follows_revision" ON "catalog"."products";
DROP FUNCTION "catalog"."products_family_follows_revision"();
REVOKE UPDATE ("family_code") ON TABLE "catalog"."products" FROM "mondapac_app";
