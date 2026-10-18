SET lock_timeout = '5s';
-- Restoring the equality fails while a tax-exclusive order exists; such orders must go first.
ALTER TABLE "ordering"."seller_orders" DROP CONSTRAINT "seller_orders_amounts_check";
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_amounts_check" CHECK (
    "subtotal_amount" >= 0 AND "shipping_amount" >= 0
    AND "total_amount" = "subtotal_amount" + "shipping_amount");
ALTER TABLE "ordering"."seller_orders" DROP CONSTRAINT "seller_orders_shipping_tax_check";
ALTER TABLE "ordering"."seller_orders"
  DROP COLUMN "shipping_tax_inclusive",
  DROP COLUMN "shipping_tax_amount",
  DROP COLUMN "shipping_tax_rate_bps";
