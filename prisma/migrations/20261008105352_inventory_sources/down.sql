-- Reverses 20261008105352_inventory_sources (docs/design/data/inventory.md 8.2): the grants first,
-- in reverse order, then the tables, children before parents. CHECKs, indexes and the foreign
-- key go with their tables. The empty schema "inventory" stays, without its USAGE grant, as the
-- leftover check of docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT, UPDATE ("name", "address", "time_zone", "priority") ON TABLE "inventory"."sources" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("low_stock_threshold", "version") ON TABLE "inventory"."seller_inventories" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "inventory"."inbox" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "inventory" FROM "mondapac_app";

DROP TABLE "inventory"."sources";
DROP TABLE "inventory"."seller_inventories";
DROP TABLE "inventory"."inbox";
