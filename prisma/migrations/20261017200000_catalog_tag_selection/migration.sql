-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "catalog"."tag_reevaluation_requests" ADD COLUMN     "cause" TEXT,
ADD COLUMN     "subject_id" UUID;


-- Hand-written: docs/design/data/catalog.md 3.15, 3.16, 3.18 and 8.1 row 10 (migration 10 of the
-- plan, slice 12 `catalog_tag_selection`), plus Mojtaba's F1 contract step from PR #397.

-- 3.18 (slice 12): a `certification-event` request names the consumed event's cause and the id
-- its selection matches (D 5.5). New nullable columns: a catalog-only change, no rewrite. The
-- column grant is unchanged: both are written once, at insert, and never updated.
ALTER TABLE "catalog"."tag_reevaluation_requests"
  ADD CONSTRAINT "tag_reevaluation_requests_cause_check" CHECK (
    ("kind" = 'certification-event') = ("cause" IS NOT NULL)
    AND ("cause" IS NULL) = ("subject_id" IS NULL)
    AND ("cause" IS NULL OR "cause" IN ('seller-certification-approved',
      'seller-certification-expired', 'seller-certification-revoked',
      'seller-certification-issuer-confirmed'))) NOT VALID;
ALTER TABLE "catalog"."tag_reevaluation_requests"
  VALIDATE CONSTRAINT "tag_reevaluation_requests_cause_check";

-- 3.15: the selection indexes of D 5.5 and the reconciliation index of D 5.6, each partial with
-- the literal predicates the queries repeat (8.4). Plain CREATE INDEX, not CONCURRENTLY: no
-- deployed environment holds catalog rows yet (8.2; the sellers list index precedent). A
-- deployed environment would build each CONCURRENTLY, alone in its file.
-- Copy names that certificate (seller or manufacturer): expired, revoked.
CREATE INDEX "offer_tags_market_id_certificate_id_idx"
  ON "catalog"."offer_tags" ("market_id", "certificate_id")
  WHERE "status" <> 'removed' AND "copy_revision_published";
-- Copy names that submission: issuer confirmed.
CREATE INDEX "offer_tags_market_id_certificate_version_id_idx"
  ON "catalog"."offer_tags" ("market_id", "certificate_version_id")
  WHERE "status" <> 'removed' AND "copy_revision_published";
-- Copy names that issuer: issuer derecognised (ADR-0028 d11).
CREATE INDEX "offer_tags_market_id_issuer_id_idx"
  ON "catalog"."offer_tags" ("market_id", "issuer_id")
  WHERE "status" <> 'removed' AND "copy_revision_published";
-- Tags of a seller (and type): seller certification approved.
CREATE INDEX "offer_tags_market_id_seller_id_type_code_idx"
  ON "catalog"."offer_tags" ("market_id", "seller_id", "type_code")
  WHERE "status" <> 'removed' AND "copy_revision_published";
-- Tags of a type: claim policy changed, manufacturer approved or coverage widened (Q-K5: one
-- index; the suspended subset is a filter over it).
CREATE INDEX "offer_tags_market_id_type_code_open_idx"
  ON "catalog"."offer_tags" ("market_id", "type_code", "offer_id")
  WHERE "status" <> 'removed' AND "copy_revision_published";
-- Daily reconciliation, oldest ask first; skips `pending-publish` (D 17.1 item 12a).
CREATE INDEX "offer_tags_market_id_evaluated_at_idx"
  ON "catalog"."offer_tags" ("market_id", "evaluated_at", "id")
  WHERE "status" NOT IN ('removed', 'pending-publish');

-- F1 (Mojtaba, PR #397; contract step of migration 9's columns): the history-presence check also
-- compares the copy's type revision and expiry. A history row recorded before migration 9 holds
-- NULL in both columns while its copy has a basis; such a legacy row is tolerated for those two
-- columns only. The NOT VALID CHECK below makes every new row with a copy carry its type
-- revision, so "a copy without a type revision" can only be a legacy row. `valid_until` may be
-- NULL on any row (a certificate without an expiry), so the CHECK does not name it.
ALTER TABLE "catalog"."offer_tag_history"
  ADD CONSTRAINT "offer_tag_history_type_revision_check" CHECK (
    "basis" IS NULL OR "type_revision_id" IS NOT NULL) NOT VALID;

CREATE OR REPLACE FUNCTION "catalog"."offer_tags_history_present"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur record;
BEGIN
  SELECT t.status, t.change_seq, t.basis, t.certificate_kind, t.certificate_id,
         t.certificate_version_id, t.issuer_id, t.type_revision_id, t.policy_revision_id,
         t.valid_until, t.copy_revision_id
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
                    AND h.copy_revision_id IS NOT DISTINCT FROM cur.copy_revision_id
                    AND ((h.type_revision_id IS NOT DISTINCT FROM cur.type_revision_id
                          AND h.valid_until IS NOT DISTINCT FROM cur.valid_until)
                         -- A row recorded before migration 9 (legacy): see the CHECK above.
                         OR (h.basis IS NOT NULL AND h.type_revision_id IS NULL
                             AND h.valid_until IS NULL))) THEN
    RAISE EXCEPTION 'catalog.offer_tags: status or copy change without its offer_tag_history row'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END; $$;
