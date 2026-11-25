-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261125230000_platform_ai_evaluations: the evaluation budget's counters go first, so
-- the old scope CHECK can come back; then the grants and the tables (their constraints and
-- indexes go with them). Only evaluation runs and their spend record are lost; no capability's
-- counting changes.
DELETE FROM "platform"."ai_budget_counters" WHERE "scope" = 'evaluation';
ALTER TABLE "platform"."ai_budget_counters" DROP CONSTRAINT "ai_budget_counters_scope_check";
ALTER TABLE "platform"."ai_budget_counters"
  ADD CONSTRAINT "ai_budget_counters_scope_check" CHECK (
    ("scope" IN ('market', 'guest') AND "scope_key" = '')
    OR ("scope" = 'capability' AND "scope_key" <> '')
    OR ("scope" = 'seller'
        AND "scope_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));

REVOKE UPDATE ("runs") ON TABLE "platform"."ai_playground_days" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "platform"."ai_playground_days" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "platform"."ai_evaluation_samples" FROM "mondapac_app";
REVOKE UPDATE ("verdict") ON TABLE "platform"."ai_evaluation_capabilities" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "platform"."ai_evaluation_capabilities" FROM "mondapac_app";
REVOKE UPDATE ("status", "started_at", "ended_at", "lease_token", "lease_until")
  ON TABLE "platform"."ai_evaluation_runs" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "platform"."ai_evaluation_runs" FROM "mondapac_app";

DROP TABLE "platform"."ai_playground_days";
DROP TABLE "platform"."ai_evaluation_samples";
DROP TABLE "platform"."ai_evaluation_capabilities";
DROP TABLE "platform"."ai_evaluation_runs";
