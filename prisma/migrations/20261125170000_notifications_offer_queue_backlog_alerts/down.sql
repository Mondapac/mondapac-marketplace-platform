-- Reverses 20261125060000_notifications_offer_queue_backlog_alerts. The history of past alerts is
-- lost; the next job run raises the alert again if the queue is still past a limit.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "notifications"."offer_queue_backlog_alerts" FROM "mondapac_app";
REVOKE UPDATE ("cleared_at") ON TABLE "notifications"."offer_queue_backlog_alerts" FROM "mondapac_app";
DROP TABLE "notifications"."offer_queue_backlog_alerts";
