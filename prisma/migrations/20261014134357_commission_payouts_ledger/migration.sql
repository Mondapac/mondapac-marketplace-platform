-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "commission_payouts";

-- CreateTable
CREATE TABLE "commission_payouts"."seller_commission_rates" (
    "market_id" VARCHAR(8) NOT NULL,
    "seller_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "rate_bps" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "seller_commission_rates_pkey" PRIMARY KEY ("market_id","seller_id")
);

-- CreateTable
CREATE TABLE "commission_payouts"."ledger_entries" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "order_line_id" UUID,
    "kind" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "rate_bps" INTEGER,
    "base_amount" BIGINT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_entries_market_id_seller_id_recorded_at_id_idx" ON "commission_payouts"."ledger_entries"("market_id", "seller_id", "recorded_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ledger_entries_market_id_seller_order_id_idx" ON "commission_payouts"."ledger_entries"("market_id", "seller_order_id");

-- Hand-written: one row per fact. A replay of the same seller order, kind and line conflicts and
-- is skipped (ON CONFLICT DO NOTHING); the shipping row has no line, so NULLs are not distinct.
CREATE UNIQUE INDEX "ledger_entries_market_id_seller_order_id_kind_order_line_id_key"
  ON "commission_payouts"."ledger_entries" ("market_id", "seller_order_id", "kind", "order_line_id")
  NULLS NOT DISTINCT;

-- Hand-written: scope and value checks.
ALTER TABLE "commission_payouts"."seller_commission_rates"
  ADD CONSTRAINT "seller_commission_rates_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_commission_rates_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_commission_rates_rate_bps_check" CHECK ("rate_bps" BETWEEN 0 AND 3000);

ALTER TABLE "commission_payouts"."ledger_entries"
  ADD CONSTRAINT "ledger_entries_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "ledger_entries_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "ledger_entries_kind_check" CHECK ("kind" IN ('sale', 'shipping', 'commission')),
  ADD CONSTRAINT "ledger_entries_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "ledger_entries_amount_check" CHECK ("amount" >= 0),
  -- A sale or a shipping fee is never zero (a free delivery writes no row).
  ADD CONSTRAINT "ledger_entries_positive_credit_check" CHECK ("kind" = 'commission' OR "amount" > 0),
  -- Only shipping has no line; only commission carries a rate and a base, and never more than it.
  ADD CONSTRAINT "ledger_entries_line_check" CHECK (("kind" = 'shipping') = ("order_line_id" IS NULL)),
  ADD CONSTRAINT "ledger_entries_commission_check" CHECK (
    ("kind" = 'commission' AND "rate_bps" IS NOT NULL AND "base_amount" IS NOT NULL
      AND "rate_bps" BETWEEN 0 AND 3000 AND "base_amount" >= 0 AND "amount" <= "base_amount")
    OR ("kind" <> 'commission' AND "rate_bps" IS NULL AND "base_amount" IS NULL));

-- Hand-written: the ledger is insert-only. No row is ever changed or removed, whoever asks.
CREATE FUNCTION "commission_payouts"."reject_mutation"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'commission_payouts.%: insert-only, % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE TRIGGER "ledger_entries_no_update" BEFORE UPDATE ON "commission_payouts"."ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."reject_mutation"();
CREATE TRIGGER "ledger_entries_no_delete" BEFORE DELETE ON "commission_payouts"."ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."reject_mutation"();
CREATE TRIGGER "ledger_entries_no_truncate" BEFORE TRUNCATE ON "commission_payouts"."ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "commission_payouts"."reject_mutation"();

-- Grants. A seller rate is inserted, changed and removed (back to the Market rate); the ledger is
-- read and appended to only.
GRANT USAGE ON SCHEMA "commission_payouts" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("rate_bps", "updated_at", "updated_by"), DELETE ON TABLE "commission_payouts"."seller_commission_rates" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "commission_payouts"."ledger_entries" TO "mondapac_app";
