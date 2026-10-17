-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable. The tax of each order line is frozen at placement from the tax module (ADR-0039
-- decision 4), with the strategy it was worked out under. Lines placed before this migration keep
-- no tax: an unknown tax is shown as unknown, never as zero.
ALTER TABLE "ordering"."orders" ADD COLUMN "tax_strategy_id" UUID;
ALTER TABLE "ordering"."order_lines" ADD COLUMN "tax_rate_bps" INTEGER,
ADD COLUMN "tax_amount" BIGINT;

-- Hand-written: value checks. The rate and the tax are set together; the rate is within the tax
-- module's range (0 to 50 %) and the tax is never negative.
ALTER TABLE "ordering"."order_lines"
  ADD CONSTRAINT "order_lines_tax_check" CHECK (
    ("tax_rate_bps" IS NULL AND "tax_amount" IS NULL)
    OR ("tax_rate_bps" BETWEEN 0 AND 5000 AND "tax_amount" >= 0)
  );

-- No grant: the columns are written only by the insert, which the app role already holds, and
-- never change afterwards.
