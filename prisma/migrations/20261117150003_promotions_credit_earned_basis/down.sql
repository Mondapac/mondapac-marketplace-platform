-- Reverses 20261117150003_promotions_credit_earned_basis. Without the basis a waiting cashback
-- would be lowered from the promotion's live rate again, so the down refuses while a cashback
-- carries one; then the guard is the 20261117140000 body again.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "promotions"."credit_issuances" WHERE "reserved_minor" IS NOT NULL) THEN
    RAISE EXCEPTION 'promotions.credit_issuances: cashback credits carry an earned basis';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "promotions"."guard_credit_transition"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."id" = OLD."id"
     AND NEW."market_id" = OLD."market_id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."promotion_id" = OLD."promotion_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."recipient_account_id" = OLD."recipient_account_id"
     AND NEW."order_id" IS NOT DISTINCT FROM OLD."order_id"
     AND NEW."source_kind" = OLD."source_kind"
     AND NEW."source_id" = OLD."source_id"
     AND NEW."currency" = OLD."currency"
     AND NEW."idempotency_key" = OLD."idempotency_key"
     AND NEW."created_at" = OLD."created_at" THEN
    -- Settle: GRANTED only after the wait (if any) ended; FAILED at any time.
    IF OLD."status" = 'PENDING' AND NEW."status" IN ('GRANTED', 'FAILED')
       AND NEW."amount_minor" = OLD."amount_minor"
       AND NEW."grant_after" IS NOT DISTINCT FROM OLD."grant_after"
       AND (NEW."status" = 'FAILED' OR OLD."grant_after" IS NULL) THEN
      RETURN NEW;
    END IF;
    -- Put the wait back: a waiting credit waits longer, nothing else changes (a payout hold on the
    -- seller order, facts that cannot be read now; Hassan M-2 and L-4).
    IF OLD."status" = 'PENDING' AND NEW."status" = 'PENDING'
       AND OLD."grant_after" IS NOT NULL AND NEW."grant_after" > OLD."grant_after"
       AND NEW."amount_minor" = OLD."amount_minor"
       AND NEW."failure_code" IS NOT DISTINCT FROM OLD."failure_code"
       AND NEW."wallet_journal_id" IS NOT DISTINCT FROM OLD."wallet_journal_id"
       AND NEW."settled_at" IS NOT DISTINCT FROM OLD."settled_at" THEN
      RETURN NEW;
    END IF;
    -- End the wait: the amount is kept or lowered, once.
    IF OLD."status" = 'PENDING' AND NEW."status" = 'PENDING'
       AND OLD."grant_after" IS NOT NULL AND NEW."grant_after" IS NULL
       AND NEW."amount_minor" <= OLD."amount_minor"
       AND NEW."failure_code" IS NOT DISTINCT FROM OLD."failure_code"
       AND NEW."wallet_journal_id" IS NOT DISTINCT FROM OLD."wallet_journal_id"
       AND NEW."settled_at" IS NOT DISTINCT FROM OLD."settled_at" THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'promotions.credit_issuances: % -> % is not allowed', OLD."status", NEW."status"
    USING ERRCODE = 'restrict_violation';
END; $$;

ALTER TABLE "promotions"."credit_issuances" DROP CONSTRAINT "credit_issuances_earned_basis_check";
ALTER TABLE "promotions"."credit_issuances" DROP COLUMN "goods_minor", DROP COLUMN "reserved_minor";
