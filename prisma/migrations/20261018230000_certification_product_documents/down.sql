-- Reverses 20261018230000_certification_product_documents: grants first, then the triggers and
-- their function, then the tables (children of the root and revision) and the extra unique on
-- uploaded_documents.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "certification"."product_revision_review_checks" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."product_revision_documents" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "certification"."product_certification_draft_documents" FROM "mondapac_app";

DROP TRIGGER "product_revision_review_checks_no_truncate" ON "certification"."product_revision_review_checks";
DROP TRIGGER "product_revision_review_checks_no_update_delete" ON "certification"."product_revision_review_checks";
DROP TRIGGER "product_revision_documents_no_truncate" ON "certification"."product_revision_documents";
DROP TRIGGER "product_revision_documents_no_update_delete" ON "certification"."product_revision_documents";
DROP TRIGGER "product_revision_documents_clean" ON "certification"."product_revision_documents";
DROP TRIGGER "product_certification_draft_documents_clean" ON "certification"."product_certification_draft_documents";
DROP FUNCTION "certification"."product_document_link_clean"();

DROP TABLE "certification"."product_revision_review_checks";
DROP TABLE "certification"."product_revision_documents";
DROP TABLE "certification"."product_certification_draft_documents";

DROP INDEX "certification"."uploaded_documents_market_id_id_type_id_key";
