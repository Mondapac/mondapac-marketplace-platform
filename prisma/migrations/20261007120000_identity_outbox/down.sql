-- Reverses 20261007120000_identity_outbox (docs/design/data/identity.md 8.2): the grants first,
-- in reverse order, then the table with its CHECKs and indexes. The empty schema "identity"
-- stays, without its USAGE grant, as the leftover check of docs/design/data/platform.md 10.5
-- (guard 2) expects.
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "identity"."outbox" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "identity" FROM "mondapac_app";
DROP TABLE "identity"."outbox";
