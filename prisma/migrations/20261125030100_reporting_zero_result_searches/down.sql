-- Reverses 20261125030100_reporting_zero_result_searches. The snapshot writes the days of its look-back
-- window again once the migration is applied again; older days are lost (search keeps its notes 35
-- days), which is acceptable for derived dashboard data.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "reporting"."daily_zero_result_searches" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "reporting"."search_snapshot_days" FROM "mondapac_app";
DROP TABLE "reporting"."daily_zero_result_searches";
DROP TABLE "reporting"."search_snapshot_days";
