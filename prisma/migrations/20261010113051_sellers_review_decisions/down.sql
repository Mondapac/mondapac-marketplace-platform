-- Reverses 20261010113051_sellers_review_decisions (docs/design/data/sellers.md 9.4): the grants
-- first; then the three new tables (their CHECKs, indexes and foreign keys go with them); then the
-- partial index, the foreign key, the CHECKs and the columns added to seller_files. For an empty or
-- development database only: it drops the review checks, the claims, the flags and every intent.
REVOKE SELECT, INSERT, UPDATE ("cleared_at", "cleared_by_account_id") ON TABLE "sellers"."admin_flags" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "sellers"."identifier_claims" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ON TABLE "sellers"."review_checks" FROM "mondapac_app";
DROP TABLE "sellers"."admin_flags";
DROP TABLE "sellers"."identifier_claims";
DROP TABLE "sellers"."review_checks";
DROP INDEX "sellers"."seller_files_market_id_decision_intent_since_idx";
ALTER TABLE "sellers"."seller_files" DROP CONSTRAINT "seller_files_market_id_seller_id_decision_revision_id_fkey";
ALTER TABLE "sellers"."seller_files" DROP CONSTRAINT "seller_files_decision_intent_set_check";
ALTER TABLE "sellers"."seller_files" DROP CONSTRAINT "seller_files_decision_intent_check";
ALTER TABLE "sellers"."seller_files" DROP CONSTRAINT "seller_files_public_store_name_check";
ALTER TABLE "sellers"."seller_files" DROP COLUMN "decision_attempt_id",
DROP COLUMN "decision_intent",
DROP COLUMN "decision_intent_since",
DROP COLUMN "decision_revision_id",
DROP COLUMN "public_store_name";
