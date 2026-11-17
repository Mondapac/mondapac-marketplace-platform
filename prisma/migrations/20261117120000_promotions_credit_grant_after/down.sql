-- Reverses 20261117120000_promotions_credit_grant_after. A waiting credit would lose its wait and
-- be granted at once, so the down refuses while one exists. A FAILED cashback keeps its old
-- wait; dropping it loses only history.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "promotions"."credit_issuances" WHERE "status" = 'PENDING' AND "grant_after" IS NOT NULL) THEN
    RAISE EXCEPTION 'promotions.credit_issuances: credits still wait for a payout release';
  END IF;
END $$;

REVOKE UPDATE ("amount_minor", "grant_after") ON TABLE "promotions"."credit_issuances" FROM "mondapac_app";

-- The guard as 20261031140000 wrote it.
CREATE OR REPLACE FUNCTION "promotions"."guard_credit_transition"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."status" = 'PENDING' AND NEW."status" IN ('GRANTED', 'FAILED')
     AND NEW."id" = OLD."id"
     AND NEW."market_id" = OLD."market_id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."promotion_id" = OLD."promotion_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."recipient_account_id" = OLD."recipient_account_id"
     AND NEW."order_id" IS NOT DISTINCT FROM OLD."order_id"
     AND NEW."source_kind" = OLD."source_kind"
     AND NEW."source_id" = OLD."source_id"
     AND NEW."amount_minor" = OLD."amount_minor"
     AND NEW."currency" = OLD."currency"
     AND NEW."idempotency_key" = OLD."idempotency_key"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'promotions.credit_issuances: % -> % is not allowed', OLD."status", NEW."status"
    USING ERRCODE = 'restrict_violation';
END; $$;

DROP INDEX "promotions"."credit_issuances_pending_cashback_idx";
ALTER TABLE "promotions"."credit_issuances" DROP CONSTRAINT "credit_issuances_grant_after_check";
ALTER TABLE "promotions"."credit_issuances" DROP COLUMN "grant_after";
