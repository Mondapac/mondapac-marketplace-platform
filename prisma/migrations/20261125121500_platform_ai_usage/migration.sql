-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AI Gateway G2 (docs/design/domain/platform-ai.md sections 7 and 10): the usage record of every
-- model call, daily totals, the budget counters and the budget reservations. Counting runs in
-- parallel with assistant.spend_days, which this migration does not touch (G7 moves it). No text,
-- customer id, IP or personal key in any table. Platform-table rule: schema platform, prefix ai_,
-- market_id leading every key, access only through platform/persistence/ai-usage/.

-- CreateTable
CREATE TABLE "platform"."ai_calls" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "day" DATE NOT NULL,
    "capability" VARCHAR(100) NOT NULL,
    "seller_id" UUID,
    "guest" BOOLEAN NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "model" VARCHAR(200) NOT NULL,
    "attempt" SMALLINT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "input_pico_usd" BIGINT NOT NULL,
    "output_pico_usd" BIGINT NOT NULL,
    "cost_micro_usd" BIGINT NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "outcome" VARCHAR(20) NOT NULL,

    CONSTRAINT "ai_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."ai_usage_days" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "capability" VARCHAR(100) NOT NULL,
    "seller_id" UUID,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "fallbacks" INTEGER NOT NULL DEFAULT 0,
    "refusals" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_micro_usd" BIGINT NOT NULL DEFAULT 0,
    "latency_le_500_ms" INTEGER NOT NULL DEFAULT 0,
    "latency_le_1000_ms" INTEGER NOT NULL DEFAULT 0,
    "latency_le_2000_ms" INTEGER NOT NULL DEFAULT 0,
    "latency_le_4000_ms" INTEGER NOT NULL DEFAULT 0,
    "latency_le_8000_ms" INTEGER NOT NULL DEFAULT 0,
    "latency_le_16000_ms" INTEGER NOT NULL DEFAULT 0,
    "latency_le_32000_ms" INTEGER NOT NULL DEFAULT 0,
    "latency_gt_32000_ms" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_usage_days_pkey" PRIMARY KEY ("id")
) WITH (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.01);

-- CreateTable
-- One UPDATE per reservation and per settle on the same few rows: fillfactor leaves room for HOT
-- updates, and autovacuum runs early (as for platform.rate_limit_counters).
CREATE TABLE "platform"."ai_budget_counters" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "period" VARCHAR(5) NOT NULL,
    "period_start" DATE NOT NULL,
    "scope" VARCHAR(10) NOT NULL,
    "scope_key" VARCHAR(100) NOT NULL,
    "held_micro_usd" BIGINT NOT NULL DEFAULT 0,
    "spent_micro_usd" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ai_budget_counters_pkey" PRIMARY KEY ("market_id","period_start","period","scope","scope_key")
) WITH (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.01);

-- CreateTable
CREATE TABLE "platform"."ai_budget_reservations" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "capability" VARCHAR(100) NOT NULL,
    "seller_id" UUID,
    "guest" BOOLEAN NOT NULL,
    "estimate_micro_usd" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_budget_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_calls_market_id_occurred_at_id_idx" ON "platform"."ai_calls"("market_id", "occurred_at", "id");

-- CreateIndex (hand-written: NULLS NOT DISTINCT, so a row without a seller is one row per day)
CREATE UNIQUE INDEX "ai_usage_days_market_id_day_capability_seller_id_key"
  ON "platform"."ai_usage_days"("market_id", "day", "capability", "seller_id")
  NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "ai_budget_reservations_market_id_expires_at_id_idx" ON "platform"."ai_budget_reservations"("market_id", "expires_at", "id");

-- Hand-written: closed values and non-negative counts.
ALTER TABLE "platform"."ai_calls"
  ADD CONSTRAINT "ai_calls_capability_check"
    CHECK ("capability" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$'),
  ADD CONSTRAINT "ai_calls_outcome_check" CHECK ("outcome" IN ('ok', 'timeout', 'unavailable')),
  ADD CONSTRAINT "ai_calls_attempt_check" CHECK ("attempt" BETWEEN 1 AND 10),
  ADD CONSTRAINT "ai_calls_guest_seller_check" CHECK (NOT ("guest" AND "seller_id" IS NOT NULL)),
  ADD CONSTRAINT "ai_calls_counts_check" CHECK (
    "input_tokens" >= 0 AND "output_tokens" >= 0 AND "input_pico_usd" >= 0
    AND "output_pico_usd" >= 0 AND "cost_micro_usd" >= 0 AND "latency_ms" >= 0);

ALTER TABLE "platform"."ai_usage_days"
  ADD CONSTRAINT "ai_usage_days_capability_check"
    CHECK ("capability" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$'),
  ADD CONSTRAINT "ai_usage_days_counts_check" CHECK (
    "calls" >= 0 AND "failures" >= 0 AND "fallbacks" >= 0 AND "refusals" >= 0
    AND "input_tokens" >= 0 AND "output_tokens" >= 0 AND "cost_micro_usd" >= 0
    AND "latency_le_500_ms" >= 0 AND "latency_le_1000_ms" >= 0 AND "latency_le_2000_ms" >= 0
    AND "latency_le_4000_ms" >= 0 AND "latency_le_8000_ms" >= 0
    AND "latency_le_16000_ms" >= 0 AND "latency_le_32000_ms" >= 0
    AND "latency_gt_32000_ms" >= 0);

ALTER TABLE "platform"."ai_budget_counters"
  ADD CONSTRAINT "ai_budget_counters_period_check" CHECK (
    ("period" = 'day') OR ("period" = 'month' AND EXTRACT(DAY FROM "period_start") = 1)),
  ADD CONSTRAINT "ai_budget_counters_scope_check" CHECK (
    ("scope" IN ('market', 'guest') AND "scope_key" = '')
    OR ("scope" = 'capability' AND "scope_key" <> '')
    OR ("scope" = 'seller'
        AND "scope_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
  -- Settled spend is part of what is held; neither is ever negative.
  ADD CONSTRAINT "ai_budget_counters_amounts_check" CHECK (
    "spent_micro_usd" >= 0 AND "held_micro_usd" >= "spent_micro_usd");

ALTER TABLE "platform"."ai_budget_reservations"
  ADD CONSTRAINT "ai_budget_reservations_capability_check"
    CHECK ("capability" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$'),
  ADD CONSTRAINT "ai_budget_reservations_guest_seller_check"
    CHECK (NOT ("guest" AND "seller_id" IS NOT NULL)),
  ADD CONSTRAINT "ai_budget_reservations_estimate_check" CHECK ("estimate_micro_usd" >= 0),
  ADD CONSTRAINT "ai_budget_reservations_expiry_check" CHECK ("expires_at" > "created_at");

-- Grants (database-designer): only what platform/persistence/ai-usage/ runs. Calls are inserted
-- and purged, never changed; days and counters are created, counted and purged; reservations
-- are created and deleted (settle, sweep), never changed.
GRANT SELECT, INSERT, DELETE ON TABLE "platform"."ai_calls" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "platform"."ai_usage_days" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "platform"."ai_budget_counters" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "platform"."ai_budget_reservations" TO "mondapac_app";
