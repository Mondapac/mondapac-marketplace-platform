-- Catalog's consumers of certification slice 15 (catalog design 5.5; certification design 3.4,
-- 8.3; docs/design/data/catalog.md 3.18): a `certification-event` request may now name the end of
-- a manufacturer certificate (suspended, revoked, expired). Each is an ending cause: it selects
-- the tags based on that certificate by its id and marks them `rechecking` before the ask, as the
-- coverage recheck of 20261018171000 does. No new column, index or grant.

-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- 3.18: the closed cause list gains the three manufacturer certificate endings. Swapped NOT VALID,
-- then validated, so the table is not scanned under the ACCESS EXCLUSIVE lock of the ADD.
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
      'product-certification-coverage-recheck', 'product-certification-suspended',
      'product-certification-revoked', 'product-certification-expired'))) NOT VALID;
ALTER TABLE "catalog"."tag_reevaluation_requests"
  VALIDATE CONSTRAINT "tag_reevaluation_requests_cause_check";
