-- Reverses 20261025120000_ordering_delivery_method: the grant, the CHECKs and the columns go. The
-- buyer's delivery method, window, ready time and attention state of every seller order are lost
-- with them (every order was 'instant' before this migration).
REVOKE UPDATE ("ready_at", "delivery_attention") ON TABLE "ordering"."seller_orders" FROM "mondapac_app";

ALTER TABLE "ordering"."seller_orders"
  DROP CONSTRAINT "seller_orders_delivery_attention_check",
  DROP CONSTRAINT "seller_orders_delivery_window_check",
  DROP CONSTRAINT "seller_orders_delivery_method_check",
  DROP COLUMN "delivery_attention",
  DROP COLUMN "ready_at",
  DROP COLUMN "delivery_window_end",
  DROP COLUMN "delivery_window_start",
  DROP COLUMN "delivery_method";
