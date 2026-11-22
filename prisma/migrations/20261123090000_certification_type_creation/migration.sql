-- Safety (docs/design/data/certification.md 9.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Add a new certificate type from the admin panel (FE-091; new-type design section 5). An admin
-- proposes a type: it is inserted `proposed` with its first revision and a pending `type-creation`
-- proposal. A second admin approves it (`active`) or rejects it (`rejected`); the proposer may
-- withdraw it (`withdrawn`). A rejected or withdrawn type is never reused: its code stays taken.
--
-- Grants: none change. The API's column-level UPDATE grant on certification_types already covers
-- "status" ("status", "published_revision_id", "version"; claims-core migration), and
-- relaxation_proposals already takes INSERT and the decision columns' UPDATE.
--
-- Both CHECKs only widen: every existing row passes them, so they are added VALID (the table
-- scan is a handful of rows).

ALTER TABLE "certification"."certification_types"
  DROP CONSTRAINT "certification_types_status_check",
  ADD CONSTRAINT "certification_types_status_check" CHECK (
    "status" IN ('proposed', 'active', 'inactive', 'rejected', 'withdrawn'));

ALTER TABLE "certification"."relaxation_proposals"
  DROP CONSTRAINT "relaxation_proposals_subject_kind_check",
  ADD CONSTRAINT "relaxation_proposals_subject_kind_check" CHECK (
    "subject_kind" IN ('type-revision', 'claim-policy-revision', 'issuer-reactivation',
                       'type-reactivation', 'type-creation'));
-- relaxation_proposals_proposed_revision_check already requires a NULL proposed_revision_id for
-- every kind but the two revision kinds, so a creation names its revision in based_on_revision_id.

-- The status lifecycle of a type (Hassan, Mojtaba): a proposal is decided once; a rejected or
-- withdrawn type is frozen for every role, the owner included; a type that was ever live never
-- goes back to a proposal. Only these moves are allowed:
--   proposed -> proposed (the proposer's edit moves the pointer) | active | rejected | withdrawn
--   active <-> inactive (CERT-03 and the reactivation of H1)
CREATE FUNCTION "certification"."certification_types_guard_status"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" IN ('rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'certification.certification_types: a rejected or withdrawn type is frozen'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'proposed'
     AND NEW."status" NOT IN ('proposed', 'active', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'certification.certification_types: a proposed type is approved, rejected or withdrawn'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('active', 'inactive') AND NEW."status" NOT IN ('active', 'inactive') THEN
    RAISE EXCEPTION 'certification.certification_types: a live type stays active or inactive'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "certification_types_status_lifecycle"
  BEFORE UPDATE ON "certification"."certification_types"
  FOR EACH ROW EXECUTE FUNCTION "certification"."certification_types_guard_status"();

-- An insert is `proposed` from the panel or `active`/`inactive` from the seed: never closed.
CREATE FUNCTION "certification"."certification_types_guard_insert"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" IN ('rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'certification.certification_types: a type is never inserted closed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "certification_types_insert_open"
  BEFORE INSERT ON "certification"."certification_types"
  FOR EACH ROW EXECUTE FUNCTION "certification"."certification_types_guard_insert"();
