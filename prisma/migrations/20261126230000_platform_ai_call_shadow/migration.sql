-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AI Gateway G6c (docs/design/domain/platform-ai.md section 8, "Built in G6c"): shadow runs of the
-- in-house model. A shadow call is a row of its own, measured only (its answer reached no one). Both
-- calls of a shadow sample (the external call and its shadow call) carry the sample's id, so the
-- two models compare on the same requests even when one of them failed, and each keeps the
-- capability's own check of its answer. No model text is kept.
-- Adding a column with a constant default is a catalogue change only (no table rewrite) since
-- PostgreSQL 11. The CHECKs are validated in the same statement, one scan under the ACCESS EXCLUSIVE
-- lock: fine while ai_calls is small (no route is usable yet). A large table would need NOT VALID
-- and a VALIDATE in a separate migration (Mojtaba, G3 and G6c reviews).
ALTER TABLE "platform"."ai_calls"
  ADD COLUMN "shadow" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "shadow_sample" UUID,
  ADD COLUMN "output_check" VARCHAR(20),
  ADD CONSTRAINT "ai_calls_output_check_check"
    CHECK ("output_check" IS NULL OR "output_check" IN ('valid', 'invalid', 'guard-rejected')),
  -- Only an answer is checked, and only in a sample.
  ADD CONSTRAINT "ai_calls_output_check_ok_check"
    CHECK ("output_check" IS NULL OR ("outcome" = 'ok' AND "shadow_sample" IS NOT NULL)),
  -- A shadow call always belongs to a sample.
  ADD CONSTRAINT "ai_calls_shadow_sample_check"
    CHECK (NOT "shadow" OR "shadow_sample" IS NOT NULL);
