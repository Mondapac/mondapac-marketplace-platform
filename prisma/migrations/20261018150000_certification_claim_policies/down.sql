-- Reverses 20261018150000_certification_claim_policies: the grants, the triggers, the pointer FK,
-- then the tables, children first.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("cleared_at", "cleared_by_account_id") ON TABLE "certification"."retired_category_flags" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."claim_policy_rows" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "certification"."claim_policy_revisions" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("published_revision_id", "version") ON TABLE "certification"."claim_basis_policies" FROM "mondapac_app";

DROP TRIGGER "claim_policy_rows_no_truncate" ON "certification"."claim_policy_rows";
DROP TRIGGER "claim_policy_rows_no_update_delete" ON "certification"."claim_policy_rows";
DROP TRIGGER "claim_policy_revisions_no_truncate" ON "certification"."claim_policy_revisions";
DROP TRIGGER "claim_policy_revisions_no_update_delete" ON "certification"."claim_policy_revisions";

ALTER TABLE "certification"."claim_basis_policies" DROP CONSTRAINT "claim_basis_policies_published_revision_fkey";

DROP TABLE "certification"."retired_category_flags";
DROP TABLE "certification"."claim_policy_rows";
DROP TABLE "certification"."claim_policy_revisions";
DROP TABLE "certification"."claim_basis_policies";
