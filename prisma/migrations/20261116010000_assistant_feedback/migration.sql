-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Feedback and insights (B3): what each assistant reply carried, and the buyer's thumbs.
ALTER TABLE "assistant"."messages"
  ADD COLUMN "notices" VARCHAR(32)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(32)[],
  ADD COLUMN "empty_search" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "messages_notices_check" CHECK (
    array_position("notices", NULL) IS NULL AND cardinality("notices") <= 8
  );

-- CreateTable
CREATE TABLE "assistant"."feedback" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "rating" VARCHAR(4) NOT NULL,
    "reason" VARCHAR(16),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("market_id","conversation_id","position")
);

-- AddForeignKey: the thumbs go with their message, so with the conversation's retention.
ALTER TABLE "assistant"."feedback" ADD CONSTRAINT "feedback_market_id_conversation_id_position_fkey" FOREIGN KEY ("market_id", "conversation_id", "position") REFERENCES "assistant"."messages"("market_id", "conversation_id", "position") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written: value checks.
ALTER TABLE "assistant"."feedback"
  ADD CONSTRAINT "feedback_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "feedback_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "feedback_rating_check" CHECK ("rating" IN ('up', 'down')),
  -- A reason belongs to a thumbs down only.
  ADD CONSTRAINT "feedback_reason_check" CHECK (
    "reason" IS NULL OR ("rating" = 'down' AND "reason" IN ('wrong', 'not-found', 'other'))
  ),
  ADD CONSTRAINT "feedback_updated_at_check" CHECK ("updated_at" >= "created_at");

-- Indexes for the admin insights (Mojtaba): every read is one Market and a range of message
-- times; the unanswered turns are a small part of the messages, so they get a partial index.
CREATE INDEX "messages_market_id_created_at_idx"
  ON "assistant"."messages" ("market_id", "created_at") WHERE "role" = 'assistant';
CREATE INDEX "messages_market_id_created_at_unanswered_idx"
  ON "assistant"."messages" ("market_id", "created_at")
  WHERE "role" = 'assistant'
    AND ("empty_search" OR "notices" && ARRAY['unavailable', 'tool-failed']::VARCHAR(32)[]);

-- Grants: written once, then only the rating and reason change (last write wins); the cascade
-- from a purged conversation does not need DELETE.
GRANT SELECT, INSERT ON TABLE "assistant"."feedback" TO "mondapac_app";
GRANT UPDATE ("rating", "reason", "updated_at") ON TABLE "assistant"."feedback" TO "mondapac_app";
