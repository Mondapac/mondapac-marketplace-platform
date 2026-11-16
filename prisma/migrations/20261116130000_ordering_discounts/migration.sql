-- Promotions package T2, part B: the discounts an order was placed with, frozen on its lines and
-- seller orders. A line's discount is split into the seller's share and the platform's share; a
-- seller order carries the sum of its lines' discounts and the discount on its delivery price.
-- Adding a NOT NULL column with a constant default is a catalogue change only (no rewrite). The
-- CHECKs are added NOT VALID and then validated, so the validation scan holds only a SHARE UPDATE
-- EXCLUSIVE lock; existing rows hold zero discounts and pass.
SET lock_timeout = '5s';

ALTER TABLE "ordering"."order_lines"
  ADD COLUMN "discount_amount" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "discount_seller_share" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "discount_platform_share" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "ordering"."order_lines"
  ADD CONSTRAINT "order_lines_discount_check" CHECK (
    "discount_seller_share" >= 0 AND "discount_platform_share" >= 0
    AND "discount_amount" = "discount_seller_share" + "discount_platform_share"
    AND "discount_amount" <= "line_amount") NOT VALID;
ALTER TABLE "ordering"."order_lines" VALIDATE CONSTRAINT "order_lines_discount_check";

ALTER TABLE "ordering"."seller_orders"
  ADD COLUMN "discount_amount" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "shipping_discount_amount" BIGINT NOT NULL DEFAULT 0;

-- The total is the goods and the delivery net of their discounts, plus any tax added on top.
ALTER TABLE "ordering"."seller_orders" DROP CONSTRAINT "seller_orders_amounts_check";
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_amounts_check" CHECK (
    "subtotal_amount" >= 0 AND "shipping_amount" >= 0
    AND "discount_amount" BETWEEN 0 AND "subtotal_amount"
    AND "shipping_discount_amount" BETWEEN 0 AND "shipping_amount"
    AND "total_amount" >= "subtotal_amount" - "discount_amount"
      + "shipping_amount" - "shipping_discount_amount") NOT VALID;
ALTER TABLE "ordering"."seller_orders" VALIDATE CONSTRAINT "seller_orders_amounts_check";

-- A pending order whose discounts no longer held when promotions redeemed them is cancelled with
-- the reason discount-changed (nothing was charged; the buyer is shown the new total).
ALTER TABLE "ordering"."orders" DROP CONSTRAINT "orders_cancel_reason_check";
ALTER TABLE "ordering"."orders"
  ADD CONSTRAINT "orders_cancel_reason_check" CHECK (
    ("status" = 'cancelled' AND "cancel_reason" IS NOT NULL AND "cancel_reason" IN
      ('expired', 'payment-failed', 'stock-unavailable', 'superseded', 'provider-failed',
       'discount-changed')
      AND "cancelled_at" IS NOT NULL)
    OR ("status" <> 'cancelled' AND "cancel_reason" IS NULL AND "cancelled_at" IS NULL)) NOT VALID;
ALTER TABLE "ordering"."orders" VALIDATE CONSTRAINT "orders_cancel_reason_check";

-- No grant: the columns are written only by the insert, which the app role already holds, and
-- never change afterwards.
