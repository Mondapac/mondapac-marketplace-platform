-- Reverses 20261019220000_notifications_admin_notices: the admin notices (and their reads, by the
-- cascade) are deleted, then the audience is limited to sellers again.
SET lock_timeout = '5s';

DELETE FROM "notifications"."in_app_notices" WHERE "audience" = 'admin';

ALTER TABLE "notifications"."in_app_notices"
  DROP CONSTRAINT "in_app_notices_audience_check",
  ADD CONSTRAINT "in_app_notices_audience_check" CHECK ("audience" IN ('seller'));
