-- Reverses 20261017200000_catalog_tag_selection (docs/design/data/catalog.md 8.3): the
-- history-presence function goes back to the slice 8 body, then the CHECK, the indexes and the
-- request columns go.
SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "catalog"."offer_tags_history_present"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur record;
BEGIN
  SELECT t.status, t.change_seq, t.basis, t.certificate_kind, t.certificate_id,
         t.certificate_version_id, t.issuer_id, t.policy_revision_id, t.copy_revision_id
    INTO cur FROM "catalog"."offer_tags" t
   WHERE t.market_id = NEW.market_id AND t.id = NEW.id;
  IF cur.change_seq <> NEW.change_seq THEN RETURN NULL; END IF;  -- a later change in the unit checks itself
  IF NOT EXISTS (SELECT 1 FROM "catalog"."offer_tag_history" h
                  WHERE h.market_id = NEW.market_id AND h.tag_id = NEW.id
                    AND h.change_seq = cur.change_seq AND h.to_status = cur.status
                    AND h.basis IS NOT DISTINCT FROM cur.basis
                    AND h.certificate_kind IS NOT DISTINCT FROM cur.certificate_kind
                    AND h.certificate_id IS NOT DISTINCT FROM cur.certificate_id
                    AND h.certificate_version_id IS NOT DISTINCT FROM cur.certificate_version_id
                    AND h.issuer_id IS NOT DISTINCT FROM cur.issuer_id
                    AND h.policy_revision_id IS NOT DISTINCT FROM cur.policy_revision_id
                    AND h.copy_revision_id IS NOT DISTINCT FROM cur.copy_revision_id) THEN
    RAISE EXCEPTION 'catalog.offer_tags: status or copy change without its offer_tag_history row'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END; $$;

ALTER TABLE "catalog"."offer_tag_history" DROP CONSTRAINT "offer_tag_history_type_revision_check";

DROP INDEX "catalog"."offer_tags_market_id_evaluated_at_idx";
DROP INDEX "catalog"."offer_tags_market_id_type_code_open_idx";
DROP INDEX "catalog"."offer_tags_market_id_seller_id_type_code_idx";
DROP INDEX "catalog"."offer_tags_market_id_issuer_id_idx";
DROP INDEX "catalog"."offer_tags_market_id_certificate_version_id_idx";
DROP INDEX "catalog"."offer_tags_market_id_certificate_id_idx";

ALTER TABLE "catalog"."tag_reevaluation_requests"
  DROP CONSTRAINT "tag_reevaluation_requests_cause_check";
ALTER TABLE "catalog"."tag_reevaluation_requests" DROP COLUMN "subject_id", DROP COLUMN "cause";
