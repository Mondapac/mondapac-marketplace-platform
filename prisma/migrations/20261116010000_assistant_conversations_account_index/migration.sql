-- Assistant: a signed-in buyer's list of their own conversations (stage 0, B2) reads one
-- account's conversations of a Market, newest activity first, by keyset (last_message_at, id).

-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex
CREATE INDEX "conversations_market_id_account_id_last_message_at_id_idx" ON "assistant"."conversations"("market_id", "account_id", "last_message_at" DESC, "id" DESC);
