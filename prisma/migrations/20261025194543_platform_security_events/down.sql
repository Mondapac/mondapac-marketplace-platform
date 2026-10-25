-- Reverses 20261025194543_platform_security_events: grants first, then the triggers, the tables
-- and the function.
REVOKE SELECT, INSERT, DELETE ON TABLE "platform"."security_events_archive" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "platform"."security_events" FROM "mondapac_app";
DROP TRIGGER "security_events_archive_no_truncate" ON "platform"."security_events_archive";
DROP TRIGGER "security_events_archive_guard_update_delete" ON "platform"."security_events_archive";
DROP TRIGGER "security_events_no_truncate" ON "platform"."security_events";
DROP TRIGGER "security_events_guard_update_delete" ON "platform"."security_events";
DROP TABLE "platform"."security_events_archive";
DROP TABLE "platform"."security_events";
DROP FUNCTION "platform"."security_events_guard_mutation"();
