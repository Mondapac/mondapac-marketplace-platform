-- Reverses 20261116100000_system_requests_overdue_reminders: drops the module's outbox (events not
-- yet relayed are lost, so this is for a database where no notice depends on them), then the
-- reminder column with its grant (the reminder history goes with it).
SET lock_timeout = '5s';
SET statement_timeout = '60s';

REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "system_requests"."outbox" FROM "mondapac_app";
DROP TABLE "system_requests"."outbox";

REVOKE UPDATE ("last_reminded_at") ON TABLE "system_requests"."requests" FROM "mondapac_app";
ALTER TABLE "system_requests"."requests" DROP COLUMN "last_reminded_at";
