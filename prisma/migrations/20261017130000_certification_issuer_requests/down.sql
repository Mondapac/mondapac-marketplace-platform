-- Reverses 20261017130000_certification_issuer_requests: grants first, then triggers and their
-- functions, then the tables (the link before the request).
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "certification"."issuer_request_documents" FROM "mondapac_app";
REVOKE UPDATE ("state", "answer_reason_code", "issuer_id", "answered_at", "answered_by_account_id", "version")
  ON TABLE "certification"."issuer_requests" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."issuer_requests" FROM "mondapac_app";

DROP TRIGGER "issuer_request_documents_no_truncate" ON "certification"."issuer_request_documents";
DROP TRIGGER "issuer_request_documents_no_update_delete" ON "certification"."issuer_request_documents";
DROP TRIGGER "issuer_request_documents_clean" ON "certification"."issuer_request_documents";
DROP FUNCTION "certification"."issuer_request_document_link_clean"();
DROP TRIGGER "issuer_requests_answer_once" ON "certification"."issuer_requests";
DROP FUNCTION "certification"."issuer_requests_guard_update"();

DROP TABLE "certification"."issuer_request_documents";
DROP TABLE "certification"."issuer_requests";
