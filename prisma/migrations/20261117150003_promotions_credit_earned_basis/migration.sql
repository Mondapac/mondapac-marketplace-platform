-- Customers phase 4c-2 (Hassan H-2): a cashback keeps what it was earned on, so a refund or the
-- grant job lowers it pro rata from that, never from the promotion's rate as it is now (a seller
-- who lowered its rate after the delivery could otherwise take back cashback the customer earned).
-- `reserved_minor` is the amount reserved at delivery and `goods_minor` the goods it was earned
-- on; both are set on insert, together and only for a cashback, and never change (the guard
-- compares them on every move). Existing rows keep null: the code lowers none of them.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "promotions"."credit_issuances"
  ADD COLUMN "reserved_minor" BIGINT,
  ADD COLUMN "goods_minor" BIGINT;

ALTER TABLE "promotions"."credit_issuances"
  ADD CONSTRAINT "credit_issuances_earned_basis_check" CHECK (
    ("reserved_minor" IS NULL AND "goods_minor" IS NULL)
    OR ("kind" = 'CASHBACK'
        AND "reserved_minor" >= 1
        AND "goods_minor" >= 1
        AND "amount_minor" <= "reserved_minor")
  ) NOT VALID;
-- Every existing row has both null: validating reads the table once under SHARE UPDATE EXCLUSIVE.
ALTER TABLE "promotions"."credit_issuances" VALIDATE CONSTRAINT "credit_issuances_earned_basis_check";

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
     AND NEW."created_at" = OLD."created_at"
     AND NEW."reserved_minor" IS NOT DISTINCT FROM OLD."reserved_minor"
     AND NEW."goods_minor" IS NOT DISTINCT FROM OLD."goods_minor" THEN
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
