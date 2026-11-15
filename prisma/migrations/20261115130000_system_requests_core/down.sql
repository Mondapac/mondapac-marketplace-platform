-- Never run this against production after launch: it drops every system request, its activity and
-- the review policy. Reverses 20261115130000_system_requests_core: the grants first, then the
-- tables (which drops their triggers), then the functions. The empty schema "system_requests"
-- stays, without its USAGE grant, as the leftover check of docs/design/data/platform.md 10.5
-- (guard 2) expects.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("review_due_days", "version", "updated_at", "updated_by_account_id") ON TABLE "system_requests"."policy_settings" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("enabled", "default_risk", "version", "updated_at", "updated_by_account_id") ON TABLE "system_requests"."policy_areas" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("last_number") ON TABLE "system_requests"."request_counters" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "system_requests"."request_activity" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "decision", "decided_by_account_id", "decided_at", "decision_reason", "superseded_by_request_id", "comment_count") ON TABLE "system_requests"."requests" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "system_requests" FROM "mondapac_app";

DROP TABLE "system_requests"."policy_settings";
DROP TABLE "system_requests"."policy_areas";
DROP TABLE "system_requests"."request_counters";
DROP TABLE "system_requests"."request_activity";
DROP TABLE "system_requests"."requests";

DROP FUNCTION "system_requests"."guard_request_decision"();
DROP FUNCTION "system_requests"."reject_mutation"();
