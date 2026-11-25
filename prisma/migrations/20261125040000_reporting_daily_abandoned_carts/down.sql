-- Reverses 20261125040000_reporting_daily_abandoned_carts. Past days are lost (a cart's state at a
-- day's end cannot be read again later), which is acceptable for derived dashboard data; the
-- snapshot writes yesterday again once the migration is applied again.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "reporting"."daily_abandoned_carts" FROM "mondapac_app";
DROP TABLE "reporting"."daily_abandoned_carts";
