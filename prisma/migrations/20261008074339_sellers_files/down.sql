-- Reverses 20261008074339_sellers_files (docs/design/data/sellers.md 9.4): the grants first, in
-- reverse order, then the tables, children before parents. CHECKs, indexes and the foreign keys
-- go with their tables. The empty schema "sellers" stays, without its USAGE grant, as the
-- leftover check of docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT, UPDATE ON TABLE "sellers"."store_profiles" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ON TABLE "sellers"."seller_tax_profiles" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ON TABLE "sellers"."seller_admin_settings" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ON TABLE "sellers"."seller_files" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "sellers"."inbox" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "sellers"."outbox" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "sellers" FROM "mondapac_app";
DROP TABLE "sellers"."store_profiles";
DROP TABLE "sellers"."seller_tax_profiles";
DROP TABLE "sellers"."seller_admin_settings";
DROP TABLE "sellers"."seller_files";
DROP TABLE "sellers"."inbox";
DROP TABLE "sellers"."outbox";
