-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AI Gateway G6c (docs/design/domain/platform-ai.md section 8, "Built in G6c"): shadow runs of the
-- in-house model. A shadow call is a row of its own, measured only (its answer reached no one), and
-- both calls of a shadow sample keep the capability's own check of their answer, so the valid-output
-- and guard-rejection rates of the two models compare on the same requests. No model text is kept.
-- Adding a column with a constant default is a catalogue change only (no table rewrite) since
-- PostgreSQL 11, and ai_calls is small (no route is usable yet), so the CHECKs validate at once.
ALTER TABLE "platform"."ai_calls"
  ADD COLUMN "shadow" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "output_check" VARCHAR(20);

ALTER TABLE "platform"."ai_calls"
  ADD CONSTRAINT "ai_calls_output_check_check"
    CHECK ("output_check" IS NULL OR "output_check" IN ('valid', 'invalid', 'guard-rejected')),
  -- Only an answer is checked: a call that is not ok has no check.
  ADD CONSTRAINT "ai_calls_output_check_ok_check"
    CHECK ("output_check" IS NULL OR "outcome" = 'ok');
