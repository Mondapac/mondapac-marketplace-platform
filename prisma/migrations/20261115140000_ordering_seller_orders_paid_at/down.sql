-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261115140000_ordering_seller_orders_paid_at. Both copies are lost:
-- orders.confirmed_at still holds the payment time, and refunded_amount the refunded gross.
REVOKE UPDATE ("paid_at", "refunded_in_full") ON TABLE "ordering"."seller_orders" FROM "mondapac_app";
ALTER TABLE "ordering"."seller_orders"
  DROP CONSTRAINT "seller_orders_refunded_in_full_check",
  DROP COLUMN "refunded_in_full",
  DROP COLUMN "paid_at";
