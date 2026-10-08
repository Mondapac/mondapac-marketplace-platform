-- Reverses 20261008213000_sellers_business_file_revisions (docs/design/data/sellers.md 9.4,
-- section 22): the grants first; then the pointer foreign key of seller_files (it names the
-- revisions); then the new table (its CHECKs, indexes, keys and its own foreign key go with it);
-- then the columns and the CHECK added to existing tables. For an empty or development database
-- only: it drops the revisions, the pointer column and the compared file versions.
REVOKE DELETE ON TABLE "sellers"."shop_slugs" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "status_changed_at", "decided_at", "decided_by_account_id", "identity_decision_id", "reject_reason_code", "withdraw_cause", "withdrawn_by_kind", "withdrawn_at") ON TABLE "sellers"."business_file_revisions" FROM "mondapac_app";
ALTER TABLE "sellers"."seller_files" DROP CONSTRAINT "seller_files_market_id_seller_id_approved_revision_id_fkey";
DROP TABLE "sellers"."business_file_revisions";
ALTER TABLE "sellers"."seller_files" DROP COLUMN "approved_revision_id";
ALTER TABLE "sellers"."register_checks" DROP CONSTRAINT "register_checks_compared_file_version_check";
ALTER TABLE "sellers"."register_checks" DROP COLUMN "compared_file_version";
