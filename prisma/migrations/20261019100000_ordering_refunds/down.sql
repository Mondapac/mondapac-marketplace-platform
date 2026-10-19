-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261019100000_ordering_refunds: the refund tables with their guards, the foreign-key
-- targets on order lines and seller orders, and the refunded amount go. Every refund and credit
-- note is lost with them.
DROP TABLE "ordering"."credit_notes";
DROP TABLE "ordering"."refund_lines";
DROP TABLE "ordering"."refunds";
DROP FUNCTION "ordering"."refunds_settle_guard"();
DROP TRIGGER "seller_orders_refunded_matches" ON "ordering"."seller_orders";
DROP FUNCTION "ordering"."seller_orders_refunded_matches"();
DROP INDEX "ordering"."order_lines_market_id_id_seller_order_id_quantity_key";
DROP INDEX "ordering"."seller_orders_market_id_id_order_id_seller_id_key";
ALTER TABLE "ordering"."seller_orders"
  DROP CONSTRAINT "seller_orders_refunded_amount_check",
  DROP COLUMN "refunded_amount";
