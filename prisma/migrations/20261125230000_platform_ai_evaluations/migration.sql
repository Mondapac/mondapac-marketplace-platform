-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AI Gateway G4c1 (docs/design/domain/platform-ai.md sections 7, 8 and 10): evaluation runs of a
-- model (provider and family) on the capabilities' synthetic evaluation sets, their per-capability
-- verdicts and per-sample results, and the playground's runs per admin and Market day. No model
-- text and no request text in any table. Platform-table rule: schema platform, prefix ai_,
-- market_id leading every key, access only through platform/persistence/ai-evaluations/.
-- The evaluation budget counts on platform.ai_budget_counters under the new scope `evaluation`.

-- CreateTable
CREATE TABLE "platform"."ai_evaluation_runs" (
    "market_id" VARCHAR(8) NOT NULL,
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "family" VARCHAR(20) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "estimate_micro_usd" BIGINT NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ(6),

    CONSTRAINT "ai_evaluation_runs_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateTable
CREATE TABLE "platform"."ai_evaluation_capabilities" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" UUID NOT NULL,
    "capability" VARCHAR(100) NOT NULL,
    "prompt_version" VARCHAR(64) NOT NULL,
    "set_version" VARCHAR(64) NOT NULL,
    "samples_total" INTEGER NOT NULL,
    "verdict" VARCHAR(16) NOT NULL,

    CONSTRAINT "ai_evaluation_capabilities_pkey" PRIMARY KEY ("market_id","run_id","capability")
);

-- CreateTable
CREATE TABLE "platform"."ai_evaluation_samples" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" UUID NOT NULL,
    "capability" VARCHAR(100) NOT NULL,
    "sample_id" VARCHAR(64) NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "checks" VARCHAR(16)[],
    "call_id" UUID,
    "route" VARCHAR(20),
    "attempt" SMALLINT,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_micro_usd" BIGINT NOT NULL,
    "latency_ms" INTEGER,
    "finished_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_evaluation_samples_pkey" PRIMARY KEY ("market_id","run_id","capability","sample_id")
);

-- CreateTable
CREATE TABLE "platform"."ai_playground_days" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "user_id" UUID NOT NULL,
    "runs" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_playground_days_pkey" PRIMARY KEY ("market_id","day","user_id")
);

-- CreateIndex
CREATE INDEX "ai_evaluation_runs_market_id_requested_at_id_idx" ON "platform"."ai_evaluation_runs"("market_id", "requested_at" DESC, "id");

-- AddForeignKey
ALTER TABLE "platform"."ai_evaluation_capabilities" ADD CONSTRAINT "ai_evaluation_capabilities_market_id_run_id_fkey" FOREIGN KEY ("market_id", "run_id") REFERENCES "platform"."ai_evaluation_runs"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform"."ai_evaluation_samples" ADD CONSTRAINT "ai_evaluation_samples_market_id_run_id_capability_fkey" FOREIGN KEY ("market_id", "run_id", "capability") REFERENCES "platform"."ai_evaluation_capabilities"("market_id", "run_id", "capability") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written: one open run (queued or running) per model and Market (Prisma cannot declare a
-- partial index). An enqueue inserts ON CONFLICT DO NOTHING and reads "no row" as run-open.
CREATE UNIQUE INDEX "ai_evaluation_runs_one_open_key"
  ON "platform"."ai_evaluation_runs"("market_id", "provider", "family")
  WHERE "status" IN ('queued', 'running');

-- Hand-written: the job's claim reads open runs of the Market oldest first (requested_at, id), a
-- handful at a time; ended runs, which are nearly all rows, stay out of the index (Mojtaba, PR
-- 1367 finding 3).
CREATE INDEX "ai_evaluation_runs_open_requested_at_idx"
  ON "platform"."ai_evaluation_runs"("market_id", "requested_at", "id")
  WHERE "status" IN ('queued', 'running');

-- Hand-written: closed values and non-negative counts.
ALTER TABLE "platform"."ai_evaluation_runs"
  ADD CONSTRAINT "ai_evaluation_runs_status_check" CHECK ("status" IN (
    'queued', 'running', 'completed', 'closed-budget', 'closed-saver', 'closed-off', 'cancelled')),
  ADD CONSTRAINT "ai_evaluation_runs_family_check" CHECK ("family" ~ '^[a-z0-9][a-z0-9.-]{0,19}$'),
  ADD CONSTRAINT "ai_evaluation_runs_estimate_check" CHECK ("estimate_micro_usd" >= 0),
  -- A running run is held by one job run: its lease token and expiry are set.
  ADD CONSTRAINT "ai_evaluation_runs_lease_check" CHECK (
    "status" <> 'running' OR ("lease_token" IS NOT NULL AND "lease_until" IS NOT NULL)),
  -- The life of a run (Mojtaba, PR 1367 finding 2): open exactly while it has no end; a queued run
  -- holds no lease; a running one has started; an end never comes before the start.
  ADD CONSTRAINT "ai_evaluation_runs_ended_check" CHECK (
    ("status" IN ('queued', 'running')) = ("ended_at" IS NULL)),
  ADD CONSTRAINT "ai_evaluation_runs_queued_lease_check" CHECK (
    "status" <> 'queued' OR ("lease_token" IS NULL AND "lease_until" IS NULL)),
  ADD CONSTRAINT "ai_evaluation_runs_started_check" CHECK (
    "status" <> 'running' OR "started_at" IS NOT NULL),
  ADD CONSTRAINT "ai_evaluation_runs_order_check" CHECK (
    "ended_at" IS NULL OR "started_at" IS NULL OR "ended_at" >= "started_at");

ALTER TABLE "platform"."ai_evaluation_capabilities"
  ADD CONSTRAINT "ai_evaluation_capabilities_capability_check"
    CHECK ("capability" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$'),
  ADD CONSTRAINT "ai_evaluation_capabilities_verdict_check" CHECK ("verdict" IN (
    'pending', 'pass-candidate', 'failed', 'incomplete', 'superseded')),
  ADD CONSTRAINT "ai_evaluation_capabilities_samples_total_check" CHECK ("samples_total" > 0);

ALTER TABLE "platform"."ai_evaluation_samples"
  ADD CONSTRAINT "ai_evaluation_samples_sample_id_check" CHECK ("sample_id" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT "ai_evaluation_samples_outcome_check" CHECK ("outcome" IN (
    'ok', 'timeout', 'unavailable', 'rate-limited', 'rejected', 'refused')),
  ADD CONSTRAINT "ai_evaluation_samples_checks_check" CHECK (
    "checks" <@ ARRAY['leak', 'empty', 'incomplete', 'too-long', 'missing-fact']::VARCHAR(16)[]),
  ADD CONSTRAINT "ai_evaluation_samples_attempt_check" CHECK ("attempt" BETWEEN 1 AND 10),
  -- A call sent has its route and attempt (Mojtaba, PR 1367 finding 2).
  ADD CONSTRAINT "ai_evaluation_samples_call_check" CHECK (
    "call_id" IS NULL OR ("route" IS NOT NULL AND "attempt" IS NOT NULL)),
  ADD CONSTRAINT "ai_evaluation_samples_counts_check" CHECK (
    "input_tokens" >= 0 AND "output_tokens" >= 0 AND "cost_micro_usd" >= 0
    AND ("latency_ms" IS NULL OR "latency_ms" >= 0));

ALTER TABLE "platform"."ai_playground_days"
  ADD CONSTRAINT "ai_playground_days_runs_check" CHECK ("runs" >= 0);

-- AI Gateway G4c: the evaluation budget's month counter, scope `evaluation` with the scope key ''.
-- The G2 migration is merged and never edited; this one widens its CHECK (as
-- 20261125170000_platform_ai_call_outcomes did for ai_calls: a small table, a brief lock).
ALTER TABLE "platform"."ai_budget_counters" DROP CONSTRAINT "ai_budget_counters_scope_check";
ALTER TABLE "platform"."ai_budget_counters"
  ADD CONSTRAINT "ai_budget_counters_scope_check" CHECK (
    ("scope" IN ('market', 'guest', 'evaluation') AND "scope_key" = '')
    OR ("scope" = 'capability' AND "scope_key" <> '')
    OR ("scope" = 'seller'
        AND "scope_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) NOT VALID;
ALTER TABLE "platform"."ai_budget_counters" VALIDATE CONSTRAINT "ai_budget_counters_scope_check";

-- Grants (database-designer): only what platform/persistence/ai-evaluations/ runs, UPDATE by
-- column (Mojtaba, PR 1367 finding 4). Runs are enqueued, claimed, renewed, finished and purged
-- (their state, start, end and lease change, nothing else); a capability's verdict is set once;
-- samples are inserted once and purged; a playground day is counted and purged.
GRANT SELECT, INSERT, DELETE ON TABLE "platform"."ai_evaluation_runs" TO "mondapac_app";
GRANT UPDATE ("status", "started_at", "ended_at", "lease_token", "lease_until")
  ON TABLE "platform"."ai_evaluation_runs" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "platform"."ai_evaluation_capabilities" TO "mondapac_app";
GRANT UPDATE ("verdict") ON TABLE "platform"."ai_evaluation_capabilities" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "platform"."ai_evaluation_samples" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "platform"."ai_playground_days" TO "mondapac_app";
GRANT UPDATE ("runs") ON TABLE "platform"."ai_playground_days" TO "mondapac_app";
