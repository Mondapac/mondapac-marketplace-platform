-- Reverses 20261115132502_customers_admin_list. The saved filters go with the table; the dropped
-- orphan stats rows come back with the next reconcile.
SET lock_timeout = '5s';

ALTER TABLE "customers"."customer_stats" DROP CONSTRAINT "customer_stats_market_id_account_id_fkey";
DROP INDEX "customers"."customer_stats_market_id_spent_minor_idx";
DROP INDEX "customers"."customer_stats_market_id_order_count_idx";
REVOKE SELECT, INSERT, UPDATE ("visibility", "name", "updated_at"), DELETE
  ON TABLE "customers"."saved_filters" FROM "mondapac_app";
DROP TABLE "customers"."saved_filters";
