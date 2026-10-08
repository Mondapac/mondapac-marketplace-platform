-- Reverses 20261008160000_sellers_identifier_tax (docs/design/data/sellers.md 9.4): the grant
-- first; then the index and the constraints added to the existing table seller_files; then the
-- new table (its CHECKs, the exclusion constraint, the index and the foreign key go with it);
-- then the columns added to seller_files. For an empty or development database only: it drops
-- the columns and their data.
REVOKE SELECT, INSERT, UPDATE ("valid_to"), DELETE ON TABLE "sellers"."tax_registration_periods" FROM "mondapac_app";
DROP INDEX "sellers"."seller_files_market_id_identifier_index_idx";
ALTER TABLE "sellers"."seller_files"
  DROP CONSTRAINT "seller_files_identifier_set_check",
  DROP CONSTRAINT "seller_files_identifier_index_check",
  DROP CONSTRAINT "seller_files_identifier_ciphertext_check",
  DROP CONSTRAINT "seller_files_identifier_scheme_check";
DROP TABLE "sellers"."tax_registration_periods";
ALTER TABLE "sellers"."seller_files"
  DROP COLUMN "identifier_scheme",
  DROP COLUMN "identifier_index",
  DROP COLUMN "identifier_ciphertext";
