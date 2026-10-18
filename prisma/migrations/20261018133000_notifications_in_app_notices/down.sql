-- Reverses 20261017220000_notifications_in_app_notices: the grants first, then the tables (the
-- reads first, for their foreign key). Every notice and read is lost.
REVOKE SELECT, INSERT ON TABLE "notifications"."in_app_notice_reads" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "notifications"."in_app_notices" FROM "mondapac_app";

DROP TABLE "notifications"."in_app_notice_reads";
DROP TABLE "notifications"."in_app_notices";
