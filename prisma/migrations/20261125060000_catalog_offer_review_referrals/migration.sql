-- Risk-based Offer approval (ADR-0051; design catalog/offer-approval section 6): the Offer review
-- policy's automatic decisions. A new, empty table; no backfill (Offers decided before it have no
-- row and the queue shows no reason chip for them).
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "catalog"."offer_review_referrals" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "offer_version" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "reasons" TEXT[] NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offer_review_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offer_review_referrals_market_id_offer_id_offer_version_tri_key" ON "catalog"."offer_review_referrals"("market_id", "offer_id", "offer_version", "trigger");

-- AddForeignKey
ALTER TABLE "catalog"."offer_review_referrals" ADD CONSTRAINT "offer_review_referrals_market_id_offer_id_seller_id_fkey" FOREIGN KEY ("market_id", "offer_id", "seller_id") REFERENCES "catalog"."offers"("market_id", "id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): the value CHECKs, insert-only triggers and grants, as for
-- catalog.offer_history (CA3).
ALTER TABLE "catalog"."offer_review_referrals"
  ADD CONSTRAINT "offer_review_referrals_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_review_referrals_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_review_referrals_offer_version_check" CHECK ("offer_version" >= 1),
  ADD CONSTRAINT "offer_review_referrals_trigger_check" CHECK ("trigger" IN ('first-publication')),
  ADD CONSTRAINT "offer_review_referrals_reasons_check" CHECK (
    array_position("reasons", NULL) IS NULL
    AND cardinality("reasons") <= 8
    AND "reasons" <@ ARRAY['emergency-stop', 'probation', 'certificate-badge', 'handling',
      'contact-text', 'full-review', 'sensitive-category', 'review-all']::text[]),
  ADD CONSTRAINT "offer_review_referrals_policy_version_check" CHECK ("policy_version" >= 1);

CREATE TRIGGER "offer_review_referrals_no_update_delete" BEFORE UPDATE OR DELETE
  ON "catalog"."offer_review_referrals"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "offer_review_referrals_no_truncate" BEFORE TRUNCATE
  ON "catalog"."offer_review_referrals"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

GRANT SELECT, INSERT ON TABLE "catalog"."offer_review_referrals" TO "mondapac_app";
