-- Reverses 20261125020000_reporting_daily_engagement. The snapshot writes the days of its look-back
-- window again once the migration is applied again; older days are lost (the behaviour behind
-- them may be gone), which is acceptable for derived dashboard data.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "reporting"."daily_engagement" FROM "mondapac_app";
DROP TABLE "reporting"."daily_engagement";
