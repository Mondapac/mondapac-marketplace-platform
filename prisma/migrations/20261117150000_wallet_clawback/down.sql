-- Reverses 20261117150000_wallet_clawback. A clawback journal would break the old checks and the
-- old lot ledger, so the down refuses while one exists.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "wallet"."journals" WHERE "kind" = 'clawback') THEN
    RAISE EXCEPTION 'wallet.journals: clawback journals exist';
  END IF;
END $$;

-- The functions as 20261025130000 wrote them.
CREATE OR REPLACE FUNCTION "wallet"."check_lot_ledger"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  lot_ids uuid[];
  lot record;
  taken numeric;
  expired numeric;
BEGIN
  IF TG_TABLE_NAME = 'lots' THEN
    lot_ids := ARRAY[NEW."id"];
  ELSIF TG_TABLE_NAME = 'hold_lots' THEN
    lot_ids := ARRAY[NEW."lot_id"];
  ELSIF TG_TABLE_NAME = 'journals' THEN
    -- An expiry names an expired promo lot of its own wallet ("expired" by the database clock,
    -- like guard_lot_update) and moves credit off the wallet, never onto it.
    IF NOT EXISTS (
      SELECT 1 FROM "wallet"."lots" l
       WHERE l."market_id" = NEW."market_id" AND l."id" = NEW."lot_id"
         AND l."wallet_account_id" = NEW."wallet_account_id"
         AND l."source" = 'promo' AND l."expires_at" <= now()
    ) THEN
      RAISE EXCEPTION 'wallet.journal %: expires no expired promo lot of its wallet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT COALESCE(SUM(p."amount_minor"), 0) FROM "wallet"."postings" p
         WHERE p."market_id" = NEW."market_id" AND p."journal_id" = NEW."id"
           AND p."account_id" = NEW."wallet_account_id") >= 0 THEN
      RAISE EXCEPTION 'wallet.journal %: an expiry takes credit off the wallet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    lot_ids := ARRAY[NEW."lot_id"];
  ELSE
    SELECT array_agg(hl."lot_id") INTO lot_ids FROM "wallet"."hold_lots" hl
     WHERE hl."market_id" = NEW."market_id" AND hl."hold_id" = NEW."id";
  END IF;
  FOR lot IN
    SELECT l."id", l."wallet_account_id", l."original_minor", l."remaining_minor"
      FROM "wallet"."lots" l
     WHERE l."market_id" = NEW."market_id" AND l."id" = ANY (lot_ids)
  LOOP
    SELECT COALESCE(SUM(hl."amount_minor"), 0) INTO taken
      FROM "wallet"."hold_lots" hl JOIN "wallet"."holds" h
        ON h."market_id" = hl."market_id" AND h."id" = hl."hold_id"
     WHERE hl."market_id" = NEW."market_id" AND hl."lot_id" = lot."id"
       AND h."status" IN ('held', 'captured');
    SELECT COALESCE(-SUM(p."amount_minor"), 0) INTO expired
      FROM "wallet"."journals" j JOIN "wallet"."postings" p
        ON p."market_id" = j."market_id" AND p."journal_id" = j."id"
     WHERE j."market_id" = NEW."market_id" AND j."lot_id" = lot."id" AND j."kind" = 'expire'
       AND p."account_id" = lot."wallet_account_id";
    IF lot."original_minor" - lot."remaining_minor" <> taken + expired THEN
      RAISE EXCEPTION 'wallet.lot %: original % remaining %, but holds took % and expiry moved %',
        lot."id", lot."original_minor", lot."remaining_minor", taken, expired
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION "wallet"."check_market_status"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  current_status text;
BEGIN
  SELECT s."status" INTO current_status FROM "wallet"."market_settings" s
   WHERE s."market_id" = NEW."market_id" FOR SHARE;
  current_status := COALESCE(current_status, 'off');
  IF current_status = 'active'
     OR (current_status = 'paused' AND NEW."kind" IN ('capture', 'release', 'expire'))
     OR (current_status = 'frozen' AND NEW."kind" IN ('release', 'expire')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'wallet.market_status: % refuses a % journal', current_status, NEW."kind"
    USING ERRCODE = 'restrict_violation';
END; $$;

DROP INDEX "wallet"."lots_market_id_journal_id_idx";

ALTER TABLE "wallet"."journals"
  DROP CONSTRAINT "journals_kind_check",
  DROP CONSTRAINT "journals_lot_check",
  ADD CONSTRAINT "journals_kind_check" CHECK ("kind" IN ('grant-promo', 'grant-refund', 'hold', 'capture', 'release', 'expire', 'reverse')),
  ADD CONSTRAINT "journals_lot_check" CHECK (("kind" = 'expire') = ("lot_id" IS NOT NULL));
