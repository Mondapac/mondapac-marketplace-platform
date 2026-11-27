-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AI Gateway G6d3 (docs/design/domain/platform-ai.md section 8, "Built in G6d3"): the auto-rollback
-- of the in-house model's percent and default stages. A rollback is a row of its own: from it on,
-- the task type's live stage is served as off until an admin changes that task type's in-house
-- settings (stage, model or share) after it. Numbers only, no text. Platform-table rule: schema
-- platform, prefix ai_, market_id leading every key, access only through
-- platform/persistence/ai-usage/.

-- CreateTable
CREATE TABLE "platform"."ai_in_house_rollbacks" (
    "market_id" VARCHAR(8) NOT NULL,
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "task" VARCHAR(16) NOT NULL,
    "family" VARCHAR(20) NOT NULL,
    "stage" VARCHAR(8) NOT NULL,
    "reason" VARCHAR(8) NOT NULL,
    "calls" INTEGER NOT NULL,
    "failures" INTEGER NOT NULL,
    "guard_rejected" INTEGER NOT NULL,
    "errors_limit_permille" SMALLINT NOT NULL,
    "guard_limit_permille" SMALLINT NOT NULL,
    "min_sample" INTEGER NOT NULL,
    "rolled_back_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_in_house_rollbacks_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateIndex
CREATE INDEX "ai_in_house_rollbacks_market_id_task_rolled_back_at_idx" ON "platform"."ai_in_house_rollbacks"("market_id", "task", "rolled_back_at" DESC);

-- Hand-written: closed values and counts within the server bounds of the limits
-- (own-model/in-house-stage.ts: 1 to 50 tenths of a percent, a sample of 100 to 10,000 calls).
ALTER TABLE "platform"."ai_in_house_rollbacks"
  ADD CONSTRAINT "ai_in_house_rollbacks_task_check"
    CHECK ("task" IN ('chat', 'extract', 'write', 'vision')),
  ADD CONSTRAINT "ai_in_house_rollbacks_family_check"
    CHECK ("family" ~ '^[a-z0-9][a-z0-9.-]{0,19}$'),
  ADD CONSTRAINT "ai_in_house_rollbacks_stage_check" CHECK ("stage" IN ('percent', 'default')),
  ADD CONSTRAINT "ai_in_house_rollbacks_reason_check" CHECK ("reason" IN ('errors', 'guard')),
  ADD CONSTRAINT "ai_in_house_rollbacks_limits_check" CHECK (
    "errors_limit_permille" BETWEEN 1 AND 50 AND "guard_limit_permille" BETWEEN 1 AND 50
    AND "min_sample" BETWEEN 100 AND 10000),
  -- A rollback is judged on at least the minimum sample, its counts within it.
  ADD CONSTRAINT "ai_in_house_rollbacks_counts_check" CHECK (
    "calls" >= "min_sample" AND "failures" BETWEEN 0 AND "calls"
    AND "guard_rejected" BETWEEN 0 AND "calls");

-- The capability's own check of an answer is kept on a served in-house call too (G6d3), not only
-- on a shadow sample (G6c): only an answer is checked. The merged G6c migration is never edited;
-- this one widens its CHECK (a small table while no route is usable, a brief lock; validated in a
-- second statement as 20261125170000_platform_ai_call_outcomes did).
ALTER TABLE "platform"."ai_calls" DROP CONSTRAINT "ai_calls_output_check_ok_check";
ALTER TABLE "platform"."ai_calls"
  ADD CONSTRAINT "ai_calls_output_check_ok_check"
    CHECK ("output_check" IS NULL OR "outcome" = 'ok') NOT VALID;
ALTER TABLE "platform"."ai_calls" VALIDATE CONSTRAINT "ai_calls_output_check_ok_check";

-- Grants (database-designer): only what platform/persistence/ai-usage/ runs. A rollback is
-- inserted once and read; it is never changed or deleted (an admin's change of the settings ends
-- it, and the rows are few).
GRANT SELECT, INSERT ON TABLE "platform"."ai_in_house_rollbacks" TO "mondapac_app";
