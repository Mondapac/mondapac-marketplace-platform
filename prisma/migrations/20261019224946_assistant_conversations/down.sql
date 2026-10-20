-- Reverses 20261019224946_assistant_conversations: the grants first, then the tables.
REVOKE SELECT, INSERT, UPDATE ON TABLE "assistant"."spend_days" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "assistant"."messages" FROM "mondapac_app";
REVOKE UPDATE ("turns", "last_message_at") ON TABLE "assistant"."conversations" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "assistant"."conversations" FROM "mondapac_app";

DROP TABLE "assistant"."spend_days";
DROP TABLE "assistant"."messages";
DROP TABLE "assistant"."conversations";
