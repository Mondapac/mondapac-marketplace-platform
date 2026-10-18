-- Catalog's consumers of certification slice 14 (catalog design 5.5; certification design 8.3;
-- docs/design/data/catalog.md 3.15, 3.18): a `certification-event` request may now name a claim
-- policy change or a manufacturer certificate approval or coverage change, each selecting the
-- tags of one certification type by its code; a coverage change also writes a recheck of the
-- certificate's own tags (Hassan M2), so one event may now write one request per cause.

-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- 3.18: the closed cause list gains the three type causes and the certificate recheck. Swapped
-- NOT VALID, then validated, so the table is not scanned under the ACCESS EXCLUSIVE lock of the ADD.
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

-- 3.18: one request per consumed event and cause (was: per event). Same name; the old unique
-- is implied by the inbox (one handler run per event) and the closed causes per handler. NULLS
-- NOT DISTINCT (Mojtaba N1): a request with an event but no cause still counts once per event.
DROP INDEX "catalog"."tag_reevaluation_requests_market_id_source_event_id_key";
CREATE UNIQUE INDEX "tag_reevaluation_requests_market_id_source_event_id_key"
  ON "catalog"."tag_reevaluation_requests" ("market_id", "source_event_id", "cause")
  NULLS NOT DISTINCT
  WHERE "source_event_id" IS NOT NULL;

-- 3.15: the type-code selection index of D 5.5, partial with the literal predicate the handler
-- query repeats (8.4), ending in `offer_id` for the keyset page. Plain CREATE INDEX, not
-- CONCURRENTLY: no deployed environment holds catalog rows yet (8.2; as migration
-- 20261017200000).
CREATE INDEX "offer_tags_market_id_type_code_offer_id_idx"
  ON "catalog"."offer_tags" ("market_id", "type_code", "offer_id")
  WHERE "status" <> 'removed' AND "copy_revision_published";
