-- Reverses 20261019100000_ordering_refunds: the refund tables, the unique key on order lines and
-- the refunded amount go. Every refund and credit note is lost with them.
DROP TABLE "ordering"."credit_notes";
DROP TABLE "ordering"."refund_lines";
DROP TABLE "ordering"."refunds";
DROP INDEX "ordering"."order_lines_market_id_id_key";
ALTER TABLE "ordering"."seller_orders"
  DROP CONSTRAINT "seller_orders_refunded_amount_check",
  DROP COLUMN "refunded_amount";
