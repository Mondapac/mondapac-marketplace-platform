-- Reverses 20261125030000_reporting_seller_monthly_goals. Unlike reporting's other tables the
-- goals are not derived data: the sellers' goals are lost and no backfill brings them back, so
-- export the table first if it holds rows that matter.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("currency", "amount", "version", "updated_at") ON TABLE "reporting"."seller_monthly_goals" FROM "mondapac_app";

DROP TABLE "reporting"."seller_monthly_goals";
