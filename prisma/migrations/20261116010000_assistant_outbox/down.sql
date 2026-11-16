-- Reverses 20261116010000_assistant_outbox: drops assistant's outbox. Events not yet relayed are
-- lost, so this is for a database where no notice depends on them.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "assistant"."outbox" FROM "mondapac_app";
DROP TABLE "assistant"."outbox";
