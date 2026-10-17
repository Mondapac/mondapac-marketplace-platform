-- Reverses 20261017090000_certification_seller_certificate_submit: grants first, then triggers and
-- their functions, then the tables (children before parents), then the columns of the root.
REVOKE SELECT, INSERT ON TABLE "certification"."seller_certification_history" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."seller_submission_documents" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "certification"."seller_certification_draft_documents" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "certification"."rate_counters" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "certification"."seller_draft_quotas" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "certification"."uploaded_documents" FROM "mondapac_app";
REVOKE DELETE ON TABLE "certification"."seller_certifications" FROM "mondapac_app";

DROP TRIGGER "seller_certification_history_no_truncate" ON "certification"."seller_certification_history";
DROP TRIGGER "seller_certification_history_no_update_delete" ON "certification"."seller_certification_history";
DROP TRIGGER "seller_submission_documents_no_truncate" ON "certification"."seller_submission_documents";
DROP TRIGGER "seller_submission_documents_no_update_delete" ON "certification"."seller_submission_documents";
DROP TRIGGER "seller_submission_documents_clean" ON "certification"."seller_submission_documents";
DROP TRIGGER "seller_certification_draft_documents_clean" ON "certification"."seller_certification_draft_documents";
DROP FUNCTION "certification"."document_link_clean"();
DROP TRIGGER "uploaded_documents_guard_update" ON "certification"."uploaded_documents";
DROP FUNCTION "certification"."uploaded_documents_guard"();

DROP TABLE "certification"."seller_certification_history";
DROP TABLE "certification"."seller_submission_documents";
DROP TABLE "certification"."seller_certification_draft_documents";
DROP TABLE "certification"."rate_counters";
DROP TABLE "certification"."seller_draft_quotas";
DROP TABLE "certification"."uploaded_documents";

ALTER TABLE "certification"."seller_certifications"
  DROP CONSTRAINT "seller_certifications_draft_note_ciphertext_check",
  DROP CONSTRAINT "seller_certifications_draft_cert_number_ciphertext_check",
  DROP CONSTRAINT "seller_certifications_draft_dates_check",
  DROP CONSTRAINT "seller_certifications_market_id_draft_issuer_id_type_id_fkey";
DROP INDEX "certification"."seller_certifications_market_id_seller_id_created_at_idx";
ALTER TABLE "certification"."seller_certifications"
  DROP COLUMN "draft_self_declared",
  DROP COLUMN "draft_self_declaration_note_ciphertext",
  DROP COLUMN "draft_issuer_id",
  DROP COLUMN "draft_issue_date",
  DROP COLUMN "draft_expiry_date",
  DROP COLUMN "draft_certificate_number_ciphertext";
