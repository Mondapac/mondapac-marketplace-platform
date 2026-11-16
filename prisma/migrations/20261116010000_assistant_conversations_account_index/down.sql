-- Reverses 20261116010000_assistant_conversations_account_index.
SET lock_timeout = '5s';

DROP INDEX "assistant"."conversations_market_id_account_id_last_message_at_id_idx";
