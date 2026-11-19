-- Reverses 20261117150002_promotions_credit_clawbacks. A clawback row is money history (the wallet
-- and the seller ledger point at it), so the down refuses while one exists.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "promotions"."credit_clawbacks") THEN
    RAISE EXCEPTION 'promotions.credit_clawbacks: clawbacks exist';
  END IF;
END $$;

DROP TABLE "promotions"."credit_clawbacks";
DROP FUNCTION "promotions"."guard_clawback_transition"();
