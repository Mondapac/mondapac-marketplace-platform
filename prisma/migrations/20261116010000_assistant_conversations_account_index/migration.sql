-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. A signed-in buyer's own list of assistant conversations (stage 0, B2): one
-- account's conversations of a Market, newest activity first, ties by id (keyset). Partial:
-- guest rows (account_id NULL) never match, so they stay out and cost no index writes. Prisma
-- cannot declare a partial index. CONCURRENTLY: assistant.conversations holds rows, so the build
-- takes no write lock; it is alone in its file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "conversations_market_id_account_id_last_message_at_id_idx" ON "assistant"."conversations" ("market_id", "account_id", "last_message_at" DESC, "id" DESC) WHERE "account_id" IS NOT NULL;
