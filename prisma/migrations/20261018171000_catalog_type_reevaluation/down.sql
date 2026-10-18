-- Reverses 20261018171000_catalog_type_reevaluation: the type-code index goes, and the cause list
-- goes back to the four seller-certificate causes. A request of a type cause cannot be
-- represented then: drop them (as 20261017200000's down). Their inbox rows stay, so the events
-- are not handled again; the daily reconciliation re-asks every live tag within 24 h.
SET lock_timeout = '5s';

DROP INDEX "catalog"."offer_tags_market_id_type_code_offer_id_idx";

DELETE FROM "catalog"."tag_reevaluation_requests"
 WHERE "cause" IN ('claim-policy-changed', 'product-certification-approved',
   'product-certification-coverage-changed');

ALTER TABLE "catalog"."tag_reevaluation_requests"
  DROP CONSTRAINT "tag_reevaluation_requests_cause_check";
ALTER TABLE "catalog"."tag_reevaluation_requests"
  ADD CONSTRAINT "tag_reevaluation_requests_cause_check" CHECK (
    ("kind" = 'certification-event') = ("cause" IS NOT NULL)
    AND ("cause" IS NULL) = ("subject_id" IS NULL)
    AND ("cause" IS NULL OR "cause" IN ('seller-certification-approved',
      'seller-certification-expired', 'seller-certification-revoked',
      'seller-certification-issuer-confirmed'))) NOT VALID;
ALTER TABLE "catalog"."tag_reevaluation_requests"
  VALIDATE CONSTRAINT "tag_reevaluation_requests_cause_check";
