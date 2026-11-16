-- Reverses 20261116200201_assistant_conversations_account_idx.
SET lock_timeout = '5s';

DROP INDEX IF EXISTS "assistant"."conversations_market_id_account_id_started_at_idx";
