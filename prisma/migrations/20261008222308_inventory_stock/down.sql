-- Reverses 20261008222308_inventory_stock (docs/design/data/inventory.md 8.2): the grants first,
-- in reverse order, then the tables, children before parents (stock_movements before
-- stock_items). CHECKs, indexes and foreign keys go with their tables.
REVOKE SELECT, INSERT, DELETE ON TABLE "inventory"."retirements" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "only_left", "changed_at", "version") ON TABLE "inventory"."availability_signals" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "inventory"."stock_movements" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("on_hand", "retired_at", "version") ON TABLE "inventory"."stock_items" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "inventory"."outbox" FROM "mondapac_app";

DROP TABLE "inventory"."retirements";
DROP TABLE "inventory"."availability_signals";
DROP TABLE "inventory"."stock_movements";
DROP TABLE "inventory"."stock_items";
DROP TABLE "inventory"."outbox";
