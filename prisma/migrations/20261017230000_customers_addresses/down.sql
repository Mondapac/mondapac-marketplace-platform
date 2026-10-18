-- Reverses 20261017230000_customers_addresses: the grants first, then the table. Every address is
-- lost with it. The empty schema "customers" stays, without its USAGE grant, as the leftover check
-- of docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT, UPDATE ("content_ciphertext", "is_default", "updated_at"), DELETE ON TABLE "customers"."addresses" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "customers" FROM "mondapac_app";

DROP TABLE "customers"."addresses";
