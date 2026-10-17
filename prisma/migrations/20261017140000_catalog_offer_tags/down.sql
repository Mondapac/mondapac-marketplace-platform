-- Reverses 20261017140000_catalog_offer_tags (docs/design/data/catalog.md 8.3): the grants, the
-- triggers and their functions, then the tables, child before parent. The insert-only triggers do
-- not fire on DROP TABLE. CHECKs, indexes and foreign keys go with their tables.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "catalog"."offer_tag_history" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "basis", "certificate_kind", "certificate_id",
  "certificate_version_id", "issuer_id", "type_revision_id", "policy_revision_id", "valid_until",
  "badge_data", "copy_revision_id", "copy_revision_published", "inputs_hash", "last_reason_code",
  "last_change_cause", "evaluated_at", "status_changed_at", "status_seq", "removed_at",
  "removed_by_kind", "removed_by_account_id")
  ON TABLE "catalog"."offer_tags" FROM "mondapac_app";
DROP TRIGGER "offer_tags_history_present" ON "catalog"."offer_tags";
DROP FUNCTION "catalog"."offer_tags_history_present"();
DROP TRIGGER "offer_tag_history_no_truncate" ON "catalog"."offer_tag_history";
DROP TRIGGER "offer_tag_history_no_update_delete" ON "catalog"."offer_tag_history";
DROP TRIGGER "offer_tags_status_seq" ON "catalog"."offer_tags";
DROP FUNCTION "catalog"."offer_tags_status_seq"();
DROP TABLE "catalog"."offer_tag_history";
DROP TABLE "catalog"."offer_tags";
