-- Reverses 20261127120000_settings_outbox: drops settings' outbox. Events not yet relayed are
-- lost, so this is for a database where no notice depends on them.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "settings"."outbox" FROM "mondapac_app";
DROP TABLE "settings"."outbox";
