-- Customers management phase 4c (Hassan H-1): a real cashback waits for the seller order's payout
-- release before the wallet is credited, so a seller who marks its own order delivered cannot have
-- the credit spent before a refund. `grant_after` is that instant; null once the amount is final
-- and for every other credit. A nullable column with no default (no rewrite); only a CASHBACK has
-- one. The grant job reads the PENDING cashback through a small partial index. The transition
-- guard gains one move, PENDING to PENDING, that ends the wait: `grant_after` to null and the
-- amount kept or lowered (a refund inside the hold), nothing else; and a credit is GRANTED only once
-- its wait has ended (the wallet is never called before). The app role may update those two
-- columns. Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "promotions"."credit_issuances" ADD COLUMN "grant_after" TIMESTAMPTZ(6);

ALTER TABLE "promotions"."credit_issuances"
  ADD CONSTRAINT "credit_issuances_grant_after_check" CHECK ("grant_after" IS NULL OR "kind" = 'CASHBACK');

-- The grant job's read: PENDING cashback only (a handful of rows at any time).
CREATE INDEX "credit_issuances_pending_cashback_idx" ON "promotions"."credit_issuances"("market_id", "created_at", "id")
  WHERE "status" = 'PENDING' AND "kind" = 'CASHBACK';

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

GRANT UPDATE ("amount_minor", "grant_after") ON TABLE "promotions"."credit_issuances" TO "mondapac_app";
