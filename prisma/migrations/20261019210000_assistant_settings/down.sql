-- Reverses 20261019210000_assistant_settings: the grants first, then the table. The empty schema
-- "assistant" stays, without its USAGE grant, as the leftover check of
-- docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT ON TABLE "assistant"."settings" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "assistant" FROM "mondapac_app";

DROP TABLE "assistant"."settings";
