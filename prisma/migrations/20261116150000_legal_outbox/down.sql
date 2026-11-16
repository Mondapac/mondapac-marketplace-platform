-- Reverses 20261116150000_legal_outbox: drops legal's outbox. Events not yet relayed are lost,
-- so this is for a database where no timeline entry depends on them.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "legal"."outbox" FROM "mondapac_app";
DROP TABLE "legal"."outbox";
