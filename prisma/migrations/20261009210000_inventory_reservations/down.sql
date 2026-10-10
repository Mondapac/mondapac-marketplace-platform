-- Reverses 20261009210000_inventory_reservations (docs/design/data/inventory.md 8.2): the grants
-- first, in reverse order, then the tables, children before parents (reservation_lines before
-- reservations). CHECKs, indexes and foreign keys go with their tables.
REVOKE UPDATE ("hold_seq") ON TABLE "inventory"."stock_items" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("max_per_customer", "version"), DELETE ON TABLE "inventory"."offer_purchase_limits" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("stock_item_id", "state", "order_line_id", "state_changed_at") ON TABLE "inventory"."reservation_lines" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "release_cause", "status_changed_at", "version") ON TABLE "inventory"."reservations" FROM "mondapac_app";

DROP TABLE "inventory"."offer_purchase_limits";
DROP TABLE "inventory"."reservation_lines";
DROP TABLE "inventory"."reservations";

ALTER TABLE "inventory"."stock_items" DROP COLUMN "hold_seq";
