-- Reverses 20261008191601_certification_claims_core (docs/design/data/certification.md 9.3): the
-- grants first, then the triggers, then the tables (the pointer foreign keys of the root and the
-- type first, then children, then parents), then the trigger function. The empty schema
-- "certification" stays, without its USAGE grant, as the leftover check of
-- docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT ON TABLE "certification"."seller_submission_decisions" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."seller_certification_submissions" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ON TABLE "certification"."seller_certifications" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("display_name", "display_name_key", "accreditation_number", "state", "expert_reference_ciphertext", "state_changed_at", "state_changed_by_kind", "state_changed_by_account_id", "version") ON TABLE "certification"."issuers" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."certification_type_revisions" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "published_revision_id", "version") ON TABLE "certification"."certification_types" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."inbox" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "certification"."outbox" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "certification" FROM "mondapac_app";
DROP TRIGGER "seller_submission_decisions_no_truncate" ON "certification"."seller_submission_decisions";
DROP TRIGGER "seller_submission_decisions_no_update_delete" ON "certification"."seller_submission_decisions";
DROP TRIGGER "seller_certification_submissions_no_truncate" ON "certification"."seller_certification_submissions";
DROP TRIGGER "seller_certification_submissions_no_update_delete" ON "certification"."seller_certification_submissions";
DROP TRIGGER "certification_type_revisions_no_truncate" ON "certification"."certification_type_revisions";
DROP TRIGGER "certification_type_revisions_no_update_delete" ON "certification"."certification_type_revisions";
ALTER TABLE "certification"."seller_certifications" DROP CONSTRAINT "seller_certifications_market_id_id_pending_submission_id_fkey";
ALTER TABLE "certification"."seller_certifications" DROP CONSTRAINT "seller_certifications_market_id_id_approved_submission_id_fkey";
ALTER TABLE "certification"."certification_types" DROP CONSTRAINT "certification_types_market_id_id_published_revision_id_fkey";
DROP TABLE "certification"."seller_submission_decisions";
DROP TABLE "certification"."seller_certification_submissions";
DROP TABLE "certification"."seller_certifications";
DROP TABLE "certification"."issuers";
DROP TABLE "certification"."certification_type_revisions";
DROP TABLE "certification"."certification_types";
DROP TABLE "certification"."inbox";
DROP TABLE "certification"."outbox";
DROP FUNCTION "certification"."reject_mutation"();
