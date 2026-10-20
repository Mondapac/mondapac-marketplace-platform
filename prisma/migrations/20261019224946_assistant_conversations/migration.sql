-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "assistant"."conversations" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID,
    "guest_token_hash" BYTEA,
    "turns" SMALLINT NOT NULL,
    "retention_days" SMALLINT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "last_message_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant"."messages" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "role" VARCHAR(16) NOT NULL,
    "text_cipher" TEXT NOT NULL,
    "cards" VARCHAR(64)[],
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("market_id","conversation_id","position")
);

-- CreateTable
CREATE TABLE "assistant"."spend_days" (
    "market_id" VARCHAR(8) NOT NULL,
    "day" DATE NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "spend_micro_usd" BIGINT NOT NULL,
    "input_tokens" BIGINT NOT NULL,
    "output_tokens" BIGINT NOT NULL,
    "conversations" INTEGER NOT NULL,
    "auto_off_cap" VARCHAR(8),
    "auto_off_at" TIMESTAMPTZ(6),

    CONSTRAINT "spend_days_pkey" PRIMARY KEY ("market_id","day")
);

-- CreateIndex
CREATE INDEX "conversations_market_id_retention_days_last_message_at_idx" ON "assistant"."conversations"("market_id", "retention_days", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_market_id_id_key" ON "assistant"."conversations"("market_id", "id");

-- AddForeignKey
ALTER TABLE "assistant"."messages" ADD CONSTRAINT "messages_market_id_conversation_id_fkey" FOREIGN KEY ("market_id", "conversation_id") REFERENCES "assistant"."conversations"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written: scope, ownership and value checks.
ALTER TABLE "assistant"."conversations"
  ADD CONSTRAINT "conversations_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "conversations_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- Exactly one owner: an account, or a guest token hash (SHA-256, 32 bytes).
  ADD CONSTRAINT "conversations_owner_check" CHECK (
    ("account_id" IS NOT NULL AND "guest_token_hash" IS NULL)
    OR ("account_id" IS NULL AND "guest_token_hash" IS NOT NULL
        AND octet_length("guest_token_hash") = 32)
  ),
  ADD CONSTRAINT "conversations_turns_check" CHECK ("turns" BETWEEN 0 AND 30),
  -- A guest's conversation keeps text 30 days at most (plan section 11).
  ADD CONSTRAINT "conversations_retention_days_check" CHECK (
    "retention_days" IN (0, 30) OR ("retention_days" = 365 AND "account_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "conversations_last_message_at_check" CHECK ("last_message_at" >= "started_at");

ALTER TABLE "assistant"."messages"
  ALTER COLUMN "cards" SET NOT NULL,
  ADD CONSTRAINT "messages_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "messages_position_check" CHECK ("position" BETWEEN 1 AND 60),
  ADD CONSTRAINT "messages_role_check" CHECK ("role" IN ('buyer', 'assistant')),
  ADD CONSTRAINT "messages_cards_check" CHECK (
    array_position("cards", NULL) IS NULL AND cardinality("cards") <= 40
  );

ALTER TABLE "assistant"."spend_days"
  ADD CONSTRAINT "spend_days_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "spend_days_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "spend_days_counts_check" CHECK (
    "spend_micro_usd" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0
    AND "conversations" >= 0
  ),
  ADD CONSTRAINT "spend_days_auto_off_check" CHECK (
    ("auto_off_cap" IS NULL AND "auto_off_at" IS NULL)
    OR ("auto_off_cap" IN ('daily', 'monthly') AND "auto_off_at" IS NOT NULL)
  );

-- Grants. Conversations: created, purged, and only their turn count and last message time
-- updated. Messages: written once and read; the cascade from a purged conversation does not need
-- DELETE on them. Spend days: counted up and read; never deleted.
GRANT SELECT, INSERT, DELETE ON TABLE "assistant"."conversations" TO "mondapac_app";
GRANT UPDATE ("turns", "last_message_at") ON TABLE "assistant"."conversations" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "assistant"."messages" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "assistant"."spend_days" TO "mondapac_app";
