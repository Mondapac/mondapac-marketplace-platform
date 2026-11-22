-- Reverses 20261123090000_certification_type_creation (docs/design/data/certification.md 9.3):
-- the triggers and their functions, then the CHECKs back to their earlier lists. The narrowed
-- CHECKs fail while a proposed, rejected or withdrawn type or a type-creation proposal exists:
-- such data has to be resolved by hand before a rollback (it is never deleted for you).
SET lock_timeout = '5s';

DROP TRIGGER "certification_types_insert_open" ON "certification"."certification_types";
DROP FUNCTION "certification"."certification_types_guard_insert"();
DROP TRIGGER "certification_types_status_lifecycle" ON "certification"."certification_types";
DROP FUNCTION "certification"."certification_types_guard_status"();

ALTER TABLE "certification"."relaxation_proposals"
  DROP CONSTRAINT "relaxation_proposals_subject_kind_check",
  ADD CONSTRAINT "relaxation_proposals_subject_kind_check" CHECK (
    "subject_kind" IN ('type-revision', 'claim-policy-revision', 'issuer-reactivation', 'type-reactivation'));

ALTER TABLE "certification"."certification_types"
  DROP CONSTRAINT "certification_types_status_check",
  ADD CONSTRAINT "certification_types_status_check" CHECK ("status" IN ('active', 'inactive'));
