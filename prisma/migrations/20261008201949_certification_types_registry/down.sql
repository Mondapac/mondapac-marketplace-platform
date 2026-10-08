-- Reverses 20261008201949_certification_types_registry (docs/design/data/certification.md 9.3):
-- the grants first, then the triggers, then the tables (children before parents), then the
-- column added to an existing table. The trigger function stays: it belongs to migration 1.
REVOKE SELECT, INSERT ON TABLE "certification"."platform_subjects" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("state", "decided_by_account_id", "decided_at", "version") ON TABLE "certification"."relaxation_proposals" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("retired_at") ON TABLE "certification"."issuer_contact_channels" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."claim_terms" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."type_revision_texts" FROM "mondapac_app";
DROP TRIGGER "claim_terms_no_truncate" ON "certification"."claim_terms";
DROP TRIGGER "claim_terms_no_update_delete" ON "certification"."claim_terms";
DROP TRIGGER "type_revision_texts_no_truncate" ON "certification"."type_revision_texts";
DROP TRIGGER "type_revision_texts_no_update_delete" ON "certification"."type_revision_texts";
DROP TABLE "certification"."platform_subjects";
DROP TABLE "certification"."relaxation_proposals";
DROP TABLE "certification"."issuer_contact_channels";
DROP TABLE "certification"."claim_terms";
DROP TABLE "certification"."type_revision_texts";
ALTER TABLE "certification"."certification_type_revisions" DROP COLUMN "change_reason_ciphertext";
