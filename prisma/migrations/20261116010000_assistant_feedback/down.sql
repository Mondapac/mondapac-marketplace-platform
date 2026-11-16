-- Reverses 20261116010000_assistant_feedback: the grants first, then the table and columns.
REVOKE UPDATE ("rating", "reason", "updated_at") ON TABLE "assistant"."feedback" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "assistant"."feedback" FROM "mondapac_app";

DROP TABLE "assistant"."feedback";

DROP INDEX "assistant"."messages_market_id_created_at_unanswered_idx";
DROP INDEX "assistant"."messages_market_id_created_at_idx";
ALTER TABLE "assistant"."messages"
  DROP CONSTRAINT "messages_notices_check",
  DROP COLUMN "empty_search",
  DROP COLUMN "notices";
