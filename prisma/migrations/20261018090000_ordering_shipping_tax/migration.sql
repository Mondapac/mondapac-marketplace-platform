-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable. The tax on each seller's flat shipping fee is frozen on the seller order with its
-- rate and price basis (ADR-0039 decision 4). Seller orders placed before this migration keep
-- none of the three: unknown is shown as unknown.
ALTER TABLE "ordering"."seller_orders"
  ADD COLUMN "shipping_tax_rate_bps" INTEGER,
  ADD COLUMN "shipping_tax_amount" BIGINT,
  ADD COLUMN "shipping_tax_inclusive" BOOLEAN;

-- Hand-written: all three or none; a rate in 0..5000 basis points (the tax module's maximum); a tax that is never negative.
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_shipping_tax_check" CHECK (
    ("shipping_tax_rate_bps" IS NULL AND "shipping_tax_amount" IS NULL AND "shipping_tax_inclusive" IS NULL)
    OR (
      "shipping_tax_rate_bps" BETWEEN 0 AND 5000
      AND "shipping_tax_amount" >= 0
      AND "shipping_tax_inclusive" IS NOT NULL
    )
  ) NOT VALID;

-- The table holds only rows written before the columns existed (all NULL), so validating is
-- cheap and takes only a SHARE UPDATE EXCLUSIVE lock.
ALTER TABLE "ordering"."seller_orders" VALIDATE CONSTRAINT "seller_orders_shipping_tax_check";

-- A tax-exclusive price is charged on top of the goods and the delivery, so a seller order's
-- total may exceed subtotal plus shipping (it never falls below). The old equality refused every
-- order placed with tax-exclusive prices; Australia's prices include tax, so it never showed.
ALTER TABLE "ordering"."seller_orders" DROP CONSTRAINT "seller_orders_amounts_check";
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_amounts_check" CHECK (
    "subtotal_amount" >= 0 AND "shipping_amount" >= 0
    AND "total_amount" >= "subtotal_amount" + "shipping_amount") NOT VALID;
ALTER TABLE "ordering"."seller_orders" VALIDATE CONSTRAINT "seller_orders_amounts_check";

-- No grant: the columns are written only by the insert, which the app role already holds, and
-- never change afterwards.
