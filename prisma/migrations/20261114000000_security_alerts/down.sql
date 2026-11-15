-- Never run this against production after launch: it drops every security alert, its delivery
-- timeline, the digest runs and the evaluator state. Reverses 20261114000000_security_alerts: the
-- grants first, then the tables (which drops their triggers and indexes), then the functions. The
-- empty schema "security" stays, without its USAGE grant, as the leftover check of
-- docs/design/data/platform.md 10.5 (guard 2) expects.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("finished_at", "opened") ON TABLE "security"."evaluator_runs" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "security"."digest_runs" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "security"."alert_deliveries" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("state", "event_count", "last_event_at", "notify_step", "next_notify_at", "acknowledged_at", "acknowledged_by", "resolved_at", "resolved_by", "resolution", "resolution_note", "version") ON TABLE "security"."alerts" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "security" FROM "mondapac_app";

DROP TABLE "security"."evaluator_runs";
DROP TABLE "security"."digest_runs";
DROP TABLE "security"."alert_deliveries";
DROP TABLE "security"."alerts";

DROP FUNCTION "security"."alerts_guard_update"();
DROP FUNCTION "security"."reject_mutation"();
