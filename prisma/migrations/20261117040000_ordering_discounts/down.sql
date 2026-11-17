SET lock_timeout = '5s';
-- Restoring the old reason list fails while an order cancelled for discount-changed exists.
ALTER TABLE "ordering"."orders" DROP CONSTRAINT "orders_cancel_reason_check";
ALTER TABLE "ordering"."orders"
  ADD CONSTRAINT "orders_cancel_reason_check" CHECK (
    ("status" = 'cancelled' AND "cancel_reason" IS NOT NULL AND "cancel_reason" IN
      ('expired', 'payment-failed', 'stock-unavailable', 'superseded', 'provider-failed')
      AND "cancelled_at" IS NOT NULL)
    OR ("status" <> 'cancelled' AND "cancel_reason" IS NULL AND "cancelled_at" IS NULL));
-- Restoring the old CHECK fails while a discounted order exists; such orders must go first.
ALTER TABLE "ordering"."seller_orders" DROP CONSTRAINT "seller_orders_amounts_check";
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_amounts_check" CHECK (
    "subtotal_amount" >= 0 AND "shipping_amount" >= 0
    AND "total_amount" >= "subtotal_amount" + "shipping_amount");
ALTER TABLE "ordering"."seller_orders"
  DROP COLUMN "shipping_discount_amount",
  DROP COLUMN "discount_amount";
ALTER TABLE "ordering"."order_lines" DROP CONSTRAINT "order_lines_discount_check";
ALTER TABLE "ordering"."order_lines"
  DROP COLUMN "discount_platform_share",
  DROP COLUMN "discount_seller_share",
  DROP COLUMN "discount_amount";
