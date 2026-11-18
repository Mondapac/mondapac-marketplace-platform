SET lock_timeout = '5s';

ALTER TABLE "ordering"."order_lines" DROP CONSTRAINT "order_lines_commission_rate_reason_check";
ALTER TABLE "ordering"."order_lines"
  DROP COLUMN "exclusive_seller",
  DROP COLUMN "commission_rate_reason";
