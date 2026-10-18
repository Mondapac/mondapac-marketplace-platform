-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable. The tax category code of the product is frozen on each order line beside the rate
-- (ADR-0039 decision 4), so a later change of the product's category never rewrites a placed
-- order. Lines placed before this migration keep no category: unknown is shown as unknown.
ALTER TABLE "ordering"."order_lines" ADD COLUMN "tax_category_code" VARCHAR(64);

-- Hand-written: the code is non-empty text. Only lines that carry a frozen rate may carry a
-- category.
ALTER TABLE "ordering"."order_lines"
  ADD CONSTRAINT "order_lines_tax_category_check" CHECK (
    "tax_category_code" IS NULL
    OR ("tax_rate_bps" IS NOT NULL AND length("tax_category_code") >= 1)
  );

-- No grant: the column is written only by the insert, which the app role already holds, and
-- never changes afterwards.
