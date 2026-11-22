-- Reverses 20261122200000_reporting_daily_rollups. Every reporting fact and rollup is lost; they
-- are derived data, rebuilt by the history backfill once the migration is applied again.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "reporting"."inbox" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "reporting"."daily_category_sales" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "reporting"."daily_seller_sales" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "reporting"."sales_entries" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("amount", "tax_amount", "shipping_amount", "shipping_tax_amount",
  "refunded_at", "refund_day", "updated_at")
  ON TABLE "reporting"."refunds" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("goods_amount", "goods_tax_amount", "units", "shipping_amount",
  "shipping_tax_amount", "paid_at", "paid_day", "cancelled_at", "cancelled_day", "shipped_at",
  "shipped_day", "shipped_on_time", "delivered_at", "delivered_day", "updated_at")
  ON TABLE "reporting"."seller_orders" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "reporting" FROM "mondapac_app";

DROP TABLE "reporting"."inbox";
DROP TABLE "reporting"."daily_category_sales";
DROP TABLE "reporting"."daily_seller_sales";
DROP TABLE "reporting"."sales_entries";
DROP TABLE "reporting"."refunds";
DROP TABLE "reporting"."seller_orders";
DROP SCHEMA "reporting";
