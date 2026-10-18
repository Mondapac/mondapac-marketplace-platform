-- Reverses 20261018170000_certification_product_certifications: the grants, the triggers, the
-- root's pointer foreign keys, then the tables, children first.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "certification"."product_certification_history" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."product_issuer_confirmations" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."product_revision_decisions" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."product_revision_editors" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."product_revision_coverage" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."product_certification_revisions" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "certification"."product_certification_draft_editors" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "certification"."product_certification_draft_coverage" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ON TABLE "certification"."product_certifications" FROM "mondapac_app";

DROP TRIGGER "product_certification_history_no_truncate" ON "certification"."product_certification_history";
DROP TRIGGER "product_certification_history_no_update_delete" ON "certification"."product_certification_history";
DROP TRIGGER "product_issuer_confirmations_no_truncate" ON "certification"."product_issuer_confirmations";
DROP TRIGGER "product_issuer_confirmations_no_update_delete" ON "certification"."product_issuer_confirmations";
DROP TRIGGER "product_revision_decisions_no_truncate" ON "certification"."product_revision_decisions";
DROP TRIGGER "product_revision_decisions_no_update_delete" ON "certification"."product_revision_decisions";
DROP TRIGGER "product_revision_editors_no_truncate" ON "certification"."product_revision_editors";
DROP TRIGGER "product_revision_editors_no_update_delete" ON "certification"."product_revision_editors";
DROP TRIGGER "product_revision_coverage_no_truncate" ON "certification"."product_revision_coverage";
DROP TRIGGER "product_revision_coverage_no_update_delete" ON "certification"."product_revision_coverage";
DROP TRIGGER "product_certification_revisions_no_truncate" ON "certification"."product_certification_revisions";
DROP TRIGGER "product_certification_revisions_no_update_delete" ON "certification"."product_certification_revisions";

ALTER TABLE "certification"."product_certifications" DROP CONSTRAINT "product_certifications_approved_revision_fkey";
ALTER TABLE "certification"."product_certifications" DROP CONSTRAINT "product_certifications_pending_revision_fkey";

DROP TABLE "certification"."product_certification_history";
DROP TABLE "certification"."product_issuer_confirmations";
DROP TABLE "certification"."product_revision_decisions";
DROP TABLE "certification"."product_revision_editors";
DROP TABLE "certification"."product_revision_coverage";
DROP TABLE "certification"."product_certification_revisions";
DROP TABLE "certification"."product_certification_draft_editors";
DROP TABLE "certification"."product_certification_draft_coverage";
DROP TABLE "certification"."product_certifications";
