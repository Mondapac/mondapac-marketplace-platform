-- Reverses 20261115110000_customers_read_models. Accepted loss: both tables are rebuilt from
-- identity and ordering by the backfill, so dropping them loses no source data.
DROP TABLE "customers"."customer_stats";
DROP TABLE "customers"."customer_directory";
