-- Reverses 20261017180000_catalog_fanout (docs/design/data/catalog.md 8.3). The entry-path lists
-- go back to the slice 8 lists; a row naming `offer-approve` fails that check, so the down is for
-- a database where no Offer approval has re-asked yet (a development rollback).
SET lock_timeout = '5s';

ALTER TABLE "catalog"."offer_tag_history" DROP CONSTRAINT "offer_tag_history_entry_path_check";
ALTER TABLE "catalog"."offer_tag_history" ADD CONSTRAINT "offer_tag_history_entry_path_check" CHECK (
  "entry_path" IN ('offer-create', 'offer-edit', 'handling-change', 'attestation-change',
    'tag-add', 'revision-submit', 'revision-publish', 'revision-revert', 'category-change',
    'match', 'promotion', 'offer-reactivated', 'tax-category-override', 'import-row',
    'certification-event', 'reconciliation', 'seller-remove', 'seller-remove-suspended',
    'offer-delete', 'product-withdrawn', 'product-retired'));
ALTER TABLE "catalog"."offer_tags" DROP CONSTRAINT "offer_tags_last_change_cause_check";
ALTER TABLE "catalog"."offer_tags" ADD CONSTRAINT "offer_tags_last_change_cause_check" CHECK (
  "last_change_cause" IS NULL OR "last_change_cause" IN ('offer-create', 'offer-edit',
    'handling-change', 'attestation-change', 'tag-add', 'revision-submit', 'revision-publish',
    'revision-revert', 'category-change', 'match', 'promotion', 'offer-reactivated',
    'tax-category-override', 'import-row', 'certification-event', 'reconciliation',
    'seller-remove', 'seller-remove-suspended', 'offer-delete', 'product-withdrawn',
    'product-retired'));

ALTER TABLE "catalog"."offer_tag_history" DROP COLUMN "valid_until", DROP COLUMN "type_revision_id";

REVOKE SELECT, INSERT, UPDATE ("state", "cursor_offer_id", "counts", "settled_at")
  ON TABLE "catalog"."tag_reevaluation_requests" FROM "mondapac_app";
DROP TABLE "catalog"."tag_reevaluation_requests";
