-- Reverses 20261008180000_sellers_register_checks (docs/design/data/sellers.md 9.4): the grant
-- first, then the table (its CHECKs, the primary key and the foreign key go with it). For an
-- empty or development database only: it drops the stored results.
REVOKE SELECT, INSERT, UPDATE ON TABLE "sellers"."register_checks" FROM "mondapac_app";
DROP TABLE "sellers"."register_checks";
