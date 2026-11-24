-- Reporting (dashboards v2, phase 1, PR 4): the ledger facts and their daily rollup, written from
-- commission-payouts' reporting facade by the ledger event worker and the ledger history backfill.
-- Two new tables; the only change to an existing table is the kind CHECK of
-- `reporting.backfill_progress`, which now also allows the ledger backfill's row.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "reporting"."ledger_entries" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "entry_id" UUID NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" BIGINT NOT NULL,
    "base_amount" BIGINT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "market_day" DATE NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("market_id","entry_id")
);

-- CreateTable
CREATE TABLE "reporting"."daily_ledger" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "market_day" DATE NOT NULL,
    "seller_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "entries" INTEGER NOT NULL,
    "seller_orders" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "base_amount" BIGINT NOT NULL,
    "refreshed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_ledger_pkey" PRIMARY KEY ("market_id","market_day","seller_id","currency","kind")
);

-- CreateIndex
CREATE INDEX "ledger_entries_market_id_market_day_seller_id_idx" ON "reporting"."ledger_entries"("market_id", "market_day", "seller_id");

-- CreateIndex
CREATE INDEX "ledger_entries_market_id_seller_order_id_idx" ON "reporting"."ledger_entries"("market_id", "seller_order_id");

-- CreateIndex
CREATE INDEX "daily_ledger_market_id_seller_id_market_day_idx" ON "reporting"."daily_ledger"("market_id", "seller_id", "market_day");

-- Hand-written.
ALTER TABLE "reporting"."ledger_entries"
  ADD CONSTRAINT "ledger_entries_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "ledger_entries_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "ledger_entries_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "ledger_entries_kind_check" CHECK (
    "kind" IN ('commission', 'refund-commission', 'cashback-seller', 'refund-cashback-seller')),
  -- As in the ledger: never negative, the kind gives the direction. A commission row has its base
  -- (goods without GST) and is never above it; a cashback row has none.
  ADD CONSTRAINT "ledger_entries_amount_check" CHECK ("amount" >= 0),
  ADD CONSTRAINT "ledger_entries_base_check" CHECK (
    ("kind" IN ('commission', 'refund-commission')
      AND "base_amount" IS NOT NULL AND "amount" <= "base_amount")
    OR ("kind" IN ('cashback-seller', 'refund-cashback-seller') AND "base_amount" IS NULL));

ALTER TABLE "reporting"."daily_ledger"
  ADD CONSTRAINT "daily_ledger_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "daily_ledger_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "daily_ledger_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "daily_ledger_kind_check" CHECK (
    "kind" IN ('commission', 'refund-commission', 'cashback-seller', 'refund-cashback-seller')),
  ADD CONSTRAINT "daily_ledger_counts_check" CHECK (
    "entries" >= 1 AND "seller_orders" BETWEEN 1 AND "entries"),
  ADD CONSTRAINT "daily_ledger_amounts_check" CHECK (
    "amount" >= 0 AND "base_amount" >= 0
    AND ("kind" IN ('commission', 'refund-commission') OR "base_amount" = 0));

ALTER TABLE "reporting"."backfill_progress"
  DROP CONSTRAINT "backfill_progress_kind_check",
  ADD CONSTRAINT "backfill_progress_kind_check" CHECK (
    "kind" IN ('seller-orders', 'refunds', 'ledger'));

-- Grants. A ledger fact is insert-only (the ledger row never changes); a seller day of the rollup
-- is replaced as a whole (delete and insert), so neither table has UPDATE.
GRANT SELECT, INSERT ON TABLE "reporting"."ledger_entries" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "reporting"."daily_ledger" TO "mondapac_app";
