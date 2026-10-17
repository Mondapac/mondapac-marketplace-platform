-- Reverses 20261017210000_ordering_tax_category: the check and the column go. The frozen category
-- is lost with them.
ALTER TABLE "ordering"."order_lines"
  DROP CONSTRAINT "order_lines_tax_category_check",
  DROP COLUMN "tax_category_code";
