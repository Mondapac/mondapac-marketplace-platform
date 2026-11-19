-- Customers phase 4c-2: a succeeded refund of a seller order whose cashback was already credited
-- takes back part of it from the customer's wallet, pro rata to the goods given back. One row per
-- (credit, refund): its share, then what the wallet actually took. `seq` makes the running total
-- race-free without a row lock: two refunds of one credit counting from the same total clash on
-- (credit, seq), and the loser is retried. Insert, and one settle of PENDING to DONE; never deleted.
-- A new table: no lock on an existing one beyond the foreign key's SHARE ROW EXCLUSIVE on
-- credit_issuances, which no deployed environment holds rows of yet.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TABLE "promotions"."credit_clawbacks" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "credit_id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "clawed_minor" BIGINT,
    "wallet_journal_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "credit_clawbacks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credit_clawbacks_market_id_credit_id_refund_id_key" ON "promotions"."credit_clawbacks"("market_id", "credit_id", "refund_id");
CREATE UNIQUE INDEX "credit_clawbacks_market_id_credit_id_seq_key" ON "promotions"."credit_clawbacks"("market_id", "credit_id", "seq");

ALTER TABLE "promotions"."credit_clawbacks" ADD CONSTRAINT "credit_clawbacks_market_id_credit_id_fkey" FOREIGN KEY ("market_id", "credit_id") REFERENCES "promotions"."credit_issuances"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "promotions"."credit_clawbacks"
  ADD CONSTRAINT "credit_clawbacks_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "credit_clawbacks_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "credit_clawbacks_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "credit_clawbacks_seq_check" CHECK ("seq" >= 1),
  ADD CONSTRAINT "credit_clawbacks_amount_check" CHECK ("amount_minor" >= 1),
  ADD CONSTRAINT "credit_clawbacks_status_check" CHECK ("status" IN ('PENDING', 'DONE')),
  -- DONE carries what was taken (0 to the share) and when; PENDING carries neither. A journal only
  -- when something was taken.
  ADD CONSTRAINT "credit_clawbacks_settled_check" CHECK (
    ("status" = 'PENDING' AND "clawed_minor" IS NULL AND "settled_at" IS NULL AND "wallet_journal_id" IS NULL)
    OR ("status" = 'DONE' AND "clawed_minor" BETWEEN 0 AND "amount_minor" AND "settled_at" IS NOT NULL
        AND ("wallet_journal_id" IS NOT NULL) = ("clawed_minor" > 0)));

-- One settle: PENDING to DONE, the settle columns only.
CREATE FUNCTION "promotions"."guard_clawback_transition"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."status" = 'PENDING' AND NEW."status" = 'DONE'
     AND NEW."id" = OLD."id" AND NEW."market_id" = OLD."market_id"
     AND NEW."tenant_id" = OLD."tenant_id" AND NEW."credit_id" = OLD."credit_id"
     AND NEW."refund_id" = OLD."refund_id" AND NEW."seq" = OLD."seq"
     AND NEW."amount_minor" = OLD."amount_minor" AND NEW."currency" = OLD."currency"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'promotions.credit_clawbacks: % -> % is not allowed', OLD."status", NEW."status"
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE TRIGGER "credit_clawbacks_transition" BEFORE UPDATE ON "promotions"."credit_clawbacks"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."guard_clawback_transition"();
CREATE TRIGGER "credit_clawbacks_no_delete" BEFORE DELETE ON "promotions"."credit_clawbacks"
  FOR EACH ROW EXECUTE FUNCTION "promotions"."reject_mutation"();
CREATE TRIGGER "credit_clawbacks_no_truncate" BEFORE TRUNCATE ON "promotions"."credit_clawbacks"
  FOR EACH STATEMENT EXECUTE FUNCTION "promotions"."reject_mutation"();

GRANT SELECT, INSERT, UPDATE ("status", "clawed_minor", "wallet_journal_id", "settled_at") ON TABLE "promotions"."credit_clawbacks" TO "mondapac_app";
