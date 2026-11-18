SET lock_timeout = '5s';

ALTER TABLE "ordering"."order_lines" DROP CONSTRAINT "order_lines_commission_standard_rate_check";
ALTER TABLE "ordering"."order_lines" DROP COLUMN "commission_standard_rate_bps";
