-- Reverses 20261017110000_ordering_tax_freeze: the check and the columns go. The frozen tax is lost
-- with them.
ALTER TABLE "ordering"."order_lines"
  DROP CONSTRAINT "order_lines_tax_check",
  DROP COLUMN "tax_amount",
  DROP COLUMN "tax_rate_bps";
ALTER TABLE "ordering"."orders" DROP COLUMN "tax_strategy_id";
