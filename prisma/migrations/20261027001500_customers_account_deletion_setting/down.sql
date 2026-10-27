-- Reverses 20261026110000_customers_account_deletion_setting: the grants first, then the tables.
-- The schema "customers" stays (it holds the address book).
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "customers"."outbox" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "customers"."account_deletion_settings" FROM "mondapac_app";

DROP TABLE "customers"."outbox";
DROP TABLE "customers"."account_deletion_settings";
