-- Reverses 20261106160000_catalog_offer_sell_units: the triggers and their functions first, then
-- the grants, then the table. Variant SKUs and "selling" switches are lost (every unit sells again).
SET lock_timeout = '5s';
DROP TRIGGER "offers_vs_unit_sku_guard_update" ON "catalog"."offers";
DROP TRIGGER "offers_vs_unit_sku_guard_insert" ON "catalog"."offers";
DROP FUNCTION "catalog"."offers_vs_unit_sku_guard"();
DROP TRIGGER "offer_sell_units_sku_guard_update" ON "catalog"."offer_sell_units";
DROP TRIGGER "offer_sell_units_sku_guard_insert" ON "catalog"."offer_sell_units";
DROP FUNCTION "catalog"."offer_sell_units_sku_guard"();
REVOKE UPDATE ("variant_sku", "selling", "version", "updated_at") ON TABLE "catalog"."offer_sell_units" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "catalog"."offer_sell_units" FROM "mondapac_app";
DROP TABLE "catalog"."offer_sell_units";
