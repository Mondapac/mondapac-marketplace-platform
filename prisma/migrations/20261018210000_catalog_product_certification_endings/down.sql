-- Reverses 20261018210000_catalog_product_certification_endings: the cause list goes back to the
-- slice 14 list. A request of an ending cause cannot be represented then: drop them (as
-- 20261018171000's down). Their inbox rows stay, so the events are not handled again; the claim is
-- already "no" for the ended certificate and the daily reconciliation re-asks every live tag
-- within 24 h.
SET lock_timeout = '5s';

DELETE FROM "catalog"."tag_reevaluation_requests"
 WHERE "cause" IN ('product-certification-suspended', 'product-certification-revoked',
   'product-certification-expired');

ALTER TABLE "catalog"."tag_reevaluation_requests"
  DROP CONSTRAINT "tag_reevaluation_requests_cause_check";
ALTER TABLE "catalog"."tag_reevaluation_requests"
  ADD CONSTRAINT "tag_reevaluation_requests_cause_check" CHECK (
    ("kind" = 'certification-event') = ("cause" IS NOT NULL)
    AND ("cause" IS NULL) = ("subject_id" IS NULL)
    AND ("cause" IS NULL OR "cause" IN ('seller-certification-approved',
      'seller-certification-expired', 'seller-certification-revoked',
      'seller-certification-issuer-confirmed', 'claim-policy-changed',
      'product-certification-approved', 'product-certification-coverage-changed',
      'product-certification-coverage-recheck'))) NOT VALID;
ALTER TABLE "catalog"."tag_reevaluation_requests"
  VALIDATE CONSTRAINT "tag_reevaluation_requests_cause_check";
