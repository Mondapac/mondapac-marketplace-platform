-- Reverses 20261017120000_certification_review: grants first, then triggers, then the tables
-- (children before parents) and the two keys added to existing tables.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, DELETE ON TABLE "certification"."document_index" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "certification"."certificate_number_index" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."seller_issuer_confirmations" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."submission_scope_readings" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."submission_review_checks" FROM "mondapac_app";

DROP TRIGGER "seller_issuer_confirmations_no_truncate" ON "certification"."seller_issuer_confirmations";
DROP TRIGGER "seller_issuer_confirmations_no_update_delete" ON "certification"."seller_issuer_confirmations";
DROP TRIGGER "submission_scope_readings_no_truncate" ON "certification"."submission_scope_readings";
DROP TRIGGER "submission_scope_readings_no_update_delete" ON "certification"."submission_scope_readings";
DROP TRIGGER "submission_review_checks_no_truncate" ON "certification"."submission_review_checks";
DROP TRIGGER "submission_review_checks_no_update_delete" ON "certification"."submission_review_checks";

DROP INDEX "certification"."seller_certifications_market_id_pending_idx";

DROP TABLE "certification"."document_index";
DROP TABLE "certification"."certificate_number_index";
DROP TABLE "certification"."seller_issuer_confirmations";
DROP TABLE "certification"."submission_scope_readings";
DROP TABLE "certification"."submission_review_checks";

DROP INDEX "certification"."uploaded_documents_market_id_id_owner_seller_id_key";
DROP INDEX "certification"."seller_cert_submissions_id_seller_key";
