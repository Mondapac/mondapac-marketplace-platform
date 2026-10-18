-- Reverses 20261018090000_legal_marketing_consent: the grants first, then the tables. Every
-- consent and its history are lost with it. The empty schema "legal" stays, without its USAGE
-- grant, as the leftover check of docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT ON TABLE "legal"."marketing_consent_changes" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("granted", "source", "changed_at") ON TABLE "legal"."marketing_consents" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "legal" FROM "mondapac_app";

DROP TABLE "legal"."marketing_consent_changes";
DROP TABLE "legal"."marketing_consents";
