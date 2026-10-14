-- Reverses 20261014130000_ordering_fulfilment: the grant, the indexes and the columns go. A
-- shipment or delivery recorded since is lost with them.
REVOKE UPDATE ("fulfilment", "carrier", "tracking_ref", "shipped_at", "delivered_at", "inventory_recorded_at") ON TABLE "ordering"."seller_orders" FROM "mondapac_app";

DROP INDEX "ordering"."seller_orders_unrecorded_shipments_idx";
DROP INDEX "ordering"."seller_orders_market_id_seller_id_order_id_idx";
ALTER TABLE "ordering"."seller_orders"
  DROP CONSTRAINT "seller_orders_fulfilment_fields_check",
  DROP CONSTRAINT "seller_orders_tracking_ref_check",
  DROP CONSTRAINT "seller_orders_carrier_check",
  DROP CONSTRAINT "seller_orders_fulfilment_check",
  DROP COLUMN "inventory_recorded_at",
  DROP COLUMN "delivered_at",
  DROP COLUMN "shipped_at",
  DROP COLUMN "tracking_ref",
  DROP COLUMN "carrier",
  DROP COLUMN "fulfilment";
