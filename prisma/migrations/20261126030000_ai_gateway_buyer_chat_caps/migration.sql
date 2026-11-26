-- AI Gateway G4d2 (docs/design/domain/platform-ai.md sections 7 and 10): the buyer assistant's
-- spend caps move from `assistant.settings` into the gateway's caps, the settings
-- `ai-cap-buyer-chat-day` and `ai-cap-buyer-chat-month` (US micro-dollars), and every capability
-- gets a month counter. Every step can run again after a failure part way through and adds
-- nothing twice. The assistant's cap columns stay (FE-20261126-ai-gateway-drop-assistant-cap-columns).
-- A blocked statement fails fast (as USAGE_LOCK_TIMEOUT_MS, 1 s) instead of queueing behind the
-- reservation traffic; a retry runs every step again.
SET lock_timeout = '1s';

-- 1. Each Market's assistant caps, as the gateway's settings, where they differ from the
--    settings' defaults (10000000 and 200000000 micro-dollars, the assistant's former defaults of
--    1000 and 20000 cents): a Market that kept the defaults gets no row and is capped by the
--    definition's default. The value is the latest assistant settings version's, cents x 10000.
--    The row and its history row (version 1, no previous value) carry the admin and the time of
--    that assistant version, so the history names who set the cap and when; no note (ADR-0009:
--    the history's note is an admin's reason, and there was none for this copy). ON CONFLICT DO
--    NOTHING: a re-run, or a Market whose row an admin already saved, keeps what is there.
WITH "latest" AS (
  SELECT DISTINCT ON ("market_id")
         "market_id", "tenant_id", "changed_at", "changed_by",
         ("daily_spend_cap_usd_cents"::bigint * 10000)::text   AS "day_value",
         ("monthly_spend_cap_usd_cents"::bigint * 10000)::text AS "month_value"
    FROM "assistant"."settings"
   ORDER BY "market_id", "version" DESC
), "copied" AS (
  SELECT "market_id", "tenant_id", 'ai-cap-buyer-chat-day' AS "code", "day_value" AS "value",
         "changed_at", "changed_by"
    FROM "latest" WHERE "day_value" <> '10000000'
  UNION ALL
  SELECT "market_id", "tenant_id", 'ai-cap-buyer-chat-month', "month_value", "changed_at", "changed_by"
    FROM "latest" WHERE "month_value" <> '200000000'
)
INSERT INTO "settings"."market_settings"
       ("market_id", "tenant_id", "code", "value", "version", "updated_at", "updated_by_account_id")
SELECT "market_id", "tenant_id", "code", "value", 1, "changed_at", "changed_by" FROM "copied"
ON CONFLICT ("market_id", "code") DO NOTHING;

WITH "latest" AS (
  SELECT DISTINCT ON ("market_id")
         "market_id", "tenant_id", "changed_at", "changed_by",
         ("daily_spend_cap_usd_cents"::bigint * 10000)::text   AS "day_value",
         ("monthly_spend_cap_usd_cents"::bigint * 10000)::text AS "month_value"
    FROM "assistant"."settings"
   ORDER BY "market_id", "version" DESC
), "copied" AS (
  SELECT "market_id", "tenant_id", 'ai-cap-buyer-chat-day' AS "code", "day_value" AS "value",
         "changed_at", "changed_by"
    FROM "latest" WHERE "day_value" <> '10000000'
  UNION ALL
  SELECT "market_id", "tenant_id", 'ai-cap-buyer-chat-month', "month_value", "changed_at", "changed_by"
    FROM "latest" WHERE "month_value" <> '200000000'
)
INSERT INTO "settings"."market_setting_history"
       ("market_id", "tenant_id", "code", "version", "previous_value", "value", "changed_at",
        "changed_by_account_id", "note")
SELECT "market_id", "tenant_id", "code", 1, NULL, "value", "changed_at", "changed_by", NULL
  FROM "copied"
ON CONFLICT ("market_id", "code", "version") DO NOTHING;

-- 2. The capability month counters, from the capability day counters of each month (a day row's
--    period_start is already the Market's day, so its month is the Market's month: no time zone
--    is needed here, ADR-0005). Every capability, as every new reservation holds its month line.
--    During the rollout the month counter is not exact, both ways (accepted, rollout window only;
--    no reconcile job): `held` includes what in-flight reservations of the old release hold, and
--    their settle leaves the month row, so those estimates stay held there this month (over-count);
--    reservations old pods make after this backfill land on the day rows only, so the month row
--    misses their cost (under-count) until the old pods are gone.
--    ON CONFLICT DO NOTHING: a re-run, or a month the new release already counted, is kept.
INSERT INTO "platform"."ai_budget_counters"
       ("market_id", "tenant_id", "period", "period_start", "scope", "scope_key",
        "held_micro_usd", "spent_micro_usd")
SELECT "market_id", "tenant_id", 'month', date_trunc('month', "period_start"::timestamp)::date,
       'capability', "scope_key", SUM("held_micro_usd"), SUM("spent_micro_usd")
  FROM "platform"."ai_budget_counters"
 WHERE "scope" = 'capability' AND "period" = 'day'
 GROUP BY "market_id", "tenant_id", date_trunc('month', "period_start"::timestamp), "scope_key"
ON CONFLICT ("market_id", "period_start", "period", "scope", "scope_key") DO NOTHING;

-- 3. A reservation says whether it held its capability's month counter. New reservations always
--    do; the ones made by a release before G4d2 (still running during the rollout) did not, and
--    their settle and sweep must leave that counter alone. Adding a column with a constant
--    default rewrites nothing. Last, so its exclusive lock on the busy
--    reservations table is held only for this statement; nothing above needs the column.
ALTER TABLE "platform"."ai_budget_reservations"
  ADD COLUMN IF NOT EXISTS "capability_month" BOOLEAN NOT NULL DEFAULT false;
