-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261125100000_platform_ai_usage: the grants, then the tables (their constraints and
-- indexes go with them). Only the gateway's own counting is lost; assistant.spend_days is untouched.
REVOKE SELECT, INSERT, DELETE ON TABLE "platform"."ai_budget_reservations" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "platform"."ai_budget_counters" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "platform"."ai_usage_days" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "platform"."ai_calls" FROM "mondapac_app";

DROP TABLE "platform"."ai_budget_reservations";
DROP TABLE "platform"."ai_budget_counters";
DROP TABLE "platform"."ai_usage_days";
DROP TABLE "platform"."ai_calls";
