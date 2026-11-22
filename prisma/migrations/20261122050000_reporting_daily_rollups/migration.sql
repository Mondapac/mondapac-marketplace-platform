-- Reporting (dashboards upgrade, option B, phase 3 PR 9): the schema of the new `reporting`
-- module. The facts (seller orders, refunds, sales entries by category) are written from the
-- owning modules' facades by the event worker, the nightly reconcile and the history backfill
-- (later PRs); the two daily rollups are rebuilt from the facts. New tables only: nothing else is
-- touched, so the migration takes no lock on an existing table.

-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "reporting";

-- CreateTable
CREATE TABLE "reporting"."seller_orders" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "goods_amount" BIGINT NOT NULL,
    "goods_tax_amount" BIGINT NOT NULL,
    "units" INTEGER NOT NULL,
    "shipping_amount" BIGINT NOT NULL,
    "shipping_tax_amount" BIGINT NOT NULL,
    "paid_at" TIMESTAMPTZ(6),
    "paid_day" DATE,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_day" DATE,
    "shipped_at" TIMESTAMPTZ(6),
    "shipped_day" DATE,
    "shipped_on_time" BOOLEAN,
    "delivered_at" TIMESTAMPTZ(6),
    "delivered_day" DATE,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_orders_pkey" PRIMARY KEY ("market_id","seller_order_id")
);

-- CreateTable
CREATE TABLE "reporting"."refunds" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "refund_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" BIGINT NOT NULL,
    "tax_amount" BIGINT NOT NULL,
    "shipping_amount" BIGINT NOT NULL,
    "shipping_tax_amount" BIGINT NOT NULL,
    "refunded_at" TIMESTAMPTZ(6) NOT NULL,
    "refund_day" DATE NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("market_id","refund_id")
);

-- CreateTable
CREATE TABLE "reporting"."sales_entries" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "market_day" DATE NOT NULL,
    "amount" BIGINT NOT NULL,
    "tax_amount" BIGINT NOT NULL,
    "units" INTEGER NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_entries_pkey" PRIMARY KEY ("market_id","kind","source_id","category_id")
);

-- CreateTable
CREATE TABLE "reporting"."daily_seller_sales" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "market_day" DATE NOT NULL,
    "seller_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "orders_paid" INTEGER NOT NULL,
    "goods_amount" BIGINT NOT NULL,
    "goods_tax_amount" BIGINT NOT NULL,
    "units" INTEGER NOT NULL,
    "shipping_amount" BIGINT NOT NULL,
    "shipping_tax_amount" BIGINT NOT NULL,
    "orders_cancelled" INTEGER NOT NULL,
    "orders_shipped" INTEGER NOT NULL,
    "orders_shipped_on_time" INTEGER NOT NULL,
    "orders_delivered" INTEGER NOT NULL,
    "refunds" INTEGER NOT NULL,
    "refund_amount" BIGINT NOT NULL,
    "refund_tax_amount" BIGINT NOT NULL,
    "refreshed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_seller_sales_pkey" PRIMARY KEY ("market_id","market_day","seller_id","currency")
);

-- CreateTable
CREATE TABLE "reporting"."daily_category_sales" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "market_day" DATE NOT NULL,
    "seller_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "orders" INTEGER NOT NULL,
    "sales_amount" BIGINT NOT NULL,
    "sales_tax_amount" BIGINT NOT NULL,
    "sales_units" INTEGER NOT NULL,
    "refund_amount" BIGINT NOT NULL,
    "refund_tax_amount" BIGINT NOT NULL,
    "refund_units" INTEGER NOT NULL,
    "refreshed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_category_sales_pkey" PRIMARY KEY ("market_id","market_day","seller_id","category_id","currency")
);

-- CreateTable
CREATE TABLE "reporting"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateIndex
CREATE INDEX "seller_orders_market_id_paid_day_seller_id_idx" ON "reporting"."seller_orders"("market_id", "paid_day", "seller_id");

-- CreateIndex
CREATE INDEX "seller_orders_market_id_cancelled_day_seller_id_idx" ON "reporting"."seller_orders"("market_id", "cancelled_day", "seller_id");

-- CreateIndex
CREATE INDEX "seller_orders_market_id_shipped_day_seller_id_idx" ON "reporting"."seller_orders"("market_id", "shipped_day", "seller_id");

-- CreateIndex
CREATE INDEX "seller_orders_market_id_delivered_day_seller_id_idx" ON "reporting"."seller_orders"("market_id", "delivered_day", "seller_id");

-- CreateIndex
CREATE INDEX "refunds_market_id_refund_day_seller_id_idx" ON "reporting"."refunds"("market_id", "refund_day", "seller_id");

-- CreateIndex
CREATE INDEX "sales_entries_market_id_market_day_seller_id_idx" ON "reporting"."sales_entries"("market_id", "market_day", "seller_id");

-- CreateIndex
CREATE INDEX "daily_seller_sales_market_id_seller_id_market_day_idx" ON "reporting"."daily_seller_sales"("market_id", "seller_id", "market_day");

-- CreateIndex
CREATE INDEX "daily_category_sales_market_id_market_day_category_id_idx" ON "reporting"."daily_category_sales"("market_id", "market_day", "category_id");



-- Hand-written.

ALTER TABLE "reporting"."seller_orders"
  ADD CONSTRAINT "seller_orders_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_orders_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_orders_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "seller_orders_goods_check" CHECK (
    "goods_amount" >= 0 AND "goods_tax_amount" BETWEEN 0 AND "goods_amount" AND "units" >= 0),
  ADD CONSTRAINT "seller_orders_shipping_check" CHECK (
    "shipping_amount" >= 0 AND "shipping_tax_amount" BETWEEN 0 AND "shipping_amount"),
  -- Each day is the day of its instant in the Market's zone: both present or both absent.
  ADD CONSTRAINT "seller_orders_paid_day_check" CHECK (("paid_at" IS NULL) = ("paid_day" IS NULL)),
  ADD CONSTRAINT "seller_orders_cancelled_day_check" CHECK (
    ("cancelled_at" IS NULL) = ("cancelled_day" IS NULL)),
  ADD CONSTRAINT "seller_orders_shipped_day_check" CHECK (
    ("shipped_at" IS NULL) = ("shipped_day" IS NULL)),
  ADD CONSTRAINT "seller_orders_delivered_day_check" CHECK (
    ("delivered_at" IS NULL) = ("delivered_day" IS NULL)),
  ADD CONSTRAINT "seller_orders_updated_check" CHECK ("updated_at" >= "recorded_at");

ALTER TABLE "reporting"."refunds"
  ADD CONSTRAINT "refunds_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "refunds_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "refunds_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  -- Positive totals; the shipping part and every tax fit inside the whole.
  ADD CONSTRAINT "refunds_amount_check" CHECK (
    "amount" >= 0 AND "tax_amount" BETWEEN 0 AND "amount"
    AND "shipping_amount" BETWEEN 0 AND "amount"
    AND "shipping_tax_amount" BETWEEN 0 AND LEAST("shipping_amount", "tax_amount")),
  ADD CONSTRAINT "refunds_updated_check" CHECK ("updated_at" >= "recorded_at");

ALTER TABLE "reporting"."sales_entries"
  ADD CONSTRAINT "sales_entries_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "sales_entries_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "sales_entries_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "sales_entries_kind_check" CHECK ("kind" IN ('sale', 'refund')),
  -- A sale is positive and a refund negative, the tax inside the amount and the units signed alike.
  ADD CONSTRAINT "sales_entries_sign_check" CHECK (
    ("kind" = 'sale' AND "amount" >= 0 AND "tax_amount" BETWEEN 0 AND "amount" AND "units" >= 0)
    OR ("kind" = 'refund' AND "amount" <= 0 AND "tax_amount" BETWEEN "amount" AND 0
        AND "units" <= 0)),
  -- A sale's source is its seller order.
  ADD CONSTRAINT "sales_entries_sale_source_check" CHECK (
    "kind" <> 'sale' OR "source_id" = "seller_order_id");

ALTER TABLE "reporting"."daily_seller_sales"
  ADD CONSTRAINT "daily_seller_sales_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "daily_seller_sales_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "daily_seller_sales_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "daily_seller_sales_counts_check" CHECK (
    "orders_paid" >= 0 AND "units" >= 0 AND "orders_cancelled" >= 0 AND "orders_shipped" >= 0
    AND "orders_shipped_on_time" BETWEEN 0 AND "orders_shipped" AND "orders_delivered" >= 0
    AND "refunds" >= 0),
  ADD CONSTRAINT "daily_seller_sales_amounts_check" CHECK (
    "goods_amount" >= 0 AND "goods_tax_amount" BETWEEN 0 AND "goods_amount"
    AND "shipping_amount" >= 0 AND "shipping_tax_amount" BETWEEN 0 AND "shipping_amount"
    AND "refund_amount" >= 0 AND "refund_tax_amount" BETWEEN 0 AND "refund_amount");

ALTER TABLE "reporting"."daily_category_sales"
  ADD CONSTRAINT "daily_category_sales_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "daily_category_sales_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "daily_category_sales_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "daily_category_sales_sales_check" CHECK (
    "orders" >= 0 AND "sales_amount" >= 0 AND "sales_tax_amount" BETWEEN 0 AND "sales_amount"
    AND "sales_units" >= 0),
  ADD CONSTRAINT "daily_category_sales_refund_check" CHECK (
    "refund_amount" <= 0 AND "refund_tax_amount" BETWEEN "refund_amount" AND 0
    AND "refund_units" <= 0);

ALTER TABLE "reporting"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^reporting\.[a-z0-9-]+$');

-- Grants. The facts are written again from the owners' facades (the key, the order, the seller,
-- the currency and the first record time never change); a refund's or a seller order's sales
-- entries are replaced as a whole (delete and insert). A rollup row is rewritten, or removed when
-- no fact of its day is left. The inbox is insert-only.
GRANT USAGE ON SCHEMA "reporting" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("goods_amount", "goods_tax_amount", "units", "shipping_amount",
  "shipping_tax_amount", "paid_at", "paid_day", "cancelled_at", "cancelled_day", "shipped_at",
  "shipped_day", "shipped_on_time", "delivered_at", "delivered_day", "updated_at")
  ON TABLE "reporting"."seller_orders" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("amount", "tax_amount", "shipping_amount", "shipping_tax_amount",
  "refunded_at", "refund_day", "updated_at")
  ON TABLE "reporting"."refunds" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "reporting"."sales_entries" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("orders_paid", "goods_amount", "goods_tax_amount", "units",
  "shipping_amount", "shipping_tax_amount", "orders_cancelled", "orders_shipped",
  "orders_shipped_on_time", "orders_delivered", "refunds", "refund_amount", "refund_tax_amount",
  "refreshed_at"), DELETE
  ON TABLE "reporting"."daily_seller_sales" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("orders", "sales_amount", "sales_tax_amount", "sales_units",
  "refund_amount", "refund_tax_amount", "refund_units", "refreshed_at"), DELETE
  ON TABLE "reporting"."daily_category_sales" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "reporting"."inbox" TO "mondapac_app";
