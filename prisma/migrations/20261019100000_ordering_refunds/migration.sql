-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Tax step 3: refunds with their tax reversal and a credit note (ADR-0007 decision 11). Built
-- behind the Market switch `tax.refundCredit.enabled` (off); nothing reaches real money until the
-- registered tax agent confirms in writing.

-- AlterTable. The gross of a seller order's refunds that have not failed. A refund raises it under
-- the value it read (optimistic), so two refunds of one seller order cannot both pass.
ALTER TABLE "ordering"."seller_orders" ADD COLUMN "refunded_amount" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ordering"."refunds" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "gross_amount" BIGINT NOT NULL,
    "tax_amount" BIGINT NOT NULL,
    "shipping_gross_amount" BIGINT NOT NULL,
    "shipping_tax_amount" BIGINT NOT NULL,
    "shipping_tax_rate_bps" INTEGER,
    "shipping_tax_inclusive" BOOLEAN,
    "reason" TEXT NOT NULL,
    "actor_population" TEXT NOT NULL,
    "actor_account_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "stripe_idempotency_key" TEXT NOT NULL,
    "stripe_refund_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordering"."refund_lines" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "refund_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "units_before" INTEGER NOT NULL,
    "gross_amount" BIGINT NOT NULL,
    "tax_amount" BIGINT NOT NULL,
    "tax_rate_bps" INTEGER NOT NULL,
    "tax_inclusive" BOOLEAN NOT NULL,

    CONSTRAINT "refund_lines_pkey" PRIMARY KEY ("refund_id","order_line_id")
);

-- CreateTable
CREATE TABLE "ordering"."credit_notes" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "refund_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "gross_amount" BIGINT NOT NULL,
    "tax_amount" BIGINT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refunds_market_id_seller_order_id_idx" ON "ordering"."refunds"("market_id", "seller_order_id");

-- CreateIndex
CREATE INDEX "refunds_market_id_state_requested_at_idx" ON "ordering"."refunds"("market_id", "state", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_market_id_id_key" ON "ordering"."refunds"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_market_id_stripe_idempotency_key_key" ON "ordering"."refunds"("market_id", "stripe_idempotency_key");

-- CreateIndex
CREATE INDEX "refund_lines_market_id_order_line_id_idx" ON "ordering"."refund_lines"("market_id", "order_line_id");

-- CreateIndex
CREATE INDEX "credit_notes_market_id_seller_order_id_idx" ON "ordering"."credit_notes"("market_id", "seller_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_market_id_refund_id_key" ON "ordering"."credit_notes"("market_id", "refund_id");

-- CreateIndex. The foreign-key target of the refund lines (the id is already the primary key).
CREATE UNIQUE INDEX "order_lines_market_id_id_key" ON "ordering"."order_lines"("market_id", "id");

-- AddForeignKey
ALTER TABLE "ordering"."refunds" ADD CONSTRAINT "refunds_market_id_seller_order_id_fkey" FOREIGN KEY ("market_id", "seller_order_id") REFERENCES "ordering"."seller_orders"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordering"."refund_lines" ADD CONSTRAINT "refund_lines_market_id_refund_id_fkey" FOREIGN KEY ("market_id", "refund_id") REFERENCES "ordering"."refunds"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordering"."refund_lines" ADD CONSTRAINT "refund_lines_market_id_order_line_id_fkey" FOREIGN KEY ("market_id", "order_line_id") REFERENCES "ordering"."order_lines"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordering"."credit_notes" ADD CONSTRAINT "credit_notes_market_id_refund_id_fkey" FOREIGN KEY ("market_id", "refund_id") REFERENCES "ordering"."refunds"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: a seller order never gives back more than it took. Every existing row holds 0.
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_refunded_amount_check" CHECK (
    "refunded_amount" >= 0 AND "refunded_amount" <= "total_amount") NOT VALID;
ALTER TABLE "ordering"."seller_orders" VALIDATE CONSTRAINT "seller_orders_refunded_amount_check";

-- Hand-written: scope and value checks of the new tables (empty, so no NOT VALID step).
ALTER TABLE "ordering"."refunds"
  ADD CONSTRAINT "refunds_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "refunds_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "refunds_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "refunds_amounts_check" CHECK (
    "gross_amount" > 0 AND "tax_amount" >= 0 AND "tax_amount" <= "gross_amount"
    AND "shipping_gross_amount" >= 0 AND "shipping_gross_amount" <= "gross_amount"
    AND "shipping_tax_amount" >= 0 AND "shipping_tax_amount" <= "shipping_gross_amount"
    AND "shipping_tax_amount" <= "tax_amount"),
  ADD CONSTRAINT "refunds_shipping_tax_check" CHECK (
    ("shipping_gross_amount" = 0 AND "shipping_tax_rate_bps" IS NULL AND "shipping_tax_inclusive" IS NULL)
    OR ("shipping_gross_amount" > 0 AND "shipping_tax_rate_bps" BETWEEN 0 AND 5000
      AND "shipping_tax_inclusive" IS NOT NULL)),
  ADD CONSTRAINT "refunds_reason_check" CHECK (
    "reason" IN ('customer-request', 'damaged', 'not-delivered', 'wrong-item', 'other')),
  ADD CONSTRAINT "refunds_actor_population_check" CHECK ("actor_population" IN ('admin', 'seller')),
  ADD CONSTRAINT "refunds_state_check" CHECK (
    ("state" = 'pending' AND "settled_at" IS NULL AND "stripe_refund_id" IS NULL)
    OR ("state" = 'succeeded' AND "settled_at" IS NOT NULL AND "stripe_refund_id" IS NOT NULL)
    OR ("state" = 'failed' AND "settled_at" IS NOT NULL AND "stripe_refund_id" IS NULL)),
  ADD CONSTRAINT "refunds_stripe_refund_id_check" CHECK (
    "stripe_refund_id" IS NULL OR "stripe_refund_id" ~ '^re_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "refunds_attempts_check" CHECK ("attempts" >= 0);

ALTER TABLE "ordering"."refund_lines"
  ADD CONSTRAINT "refund_lines_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "refund_lines_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "refund_lines_quantity_check" CHECK (
    "quantity" BETWEEN 1 AND 999 AND "units_before" BETWEEN 0 AND 998
    AND "units_before" + "quantity" <= 999),
  ADD CONSTRAINT "refund_lines_amounts_check" CHECK (
    "gross_amount" > 0 AND "tax_amount" >= 0 AND "tax_amount" <= "gross_amount"),
  ADD CONSTRAINT "refund_lines_tax_rate_check" CHECK ("tax_rate_bps" BETWEEN 0 AND 5000);

ALTER TABLE "ordering"."credit_notes"
  ADD CONSTRAINT "credit_notes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "credit_notes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "credit_notes_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "credit_notes_amounts_check" CHECK (
    "gross_amount" > 0 AND "tax_amount" >= 0 AND "tax_amount" <= "gross_amount");

-- Hand-written: at most one pending refund per seller order, and one Stripe refund belongs to one
-- refund. Invisible to Prisma.
CREATE UNIQUE INDEX "refunds_one_pending_key" ON "ordering"."refunds" ("market_id", "seller_order_id") WHERE "state" = 'pending';
CREATE UNIQUE INDEX "refunds_stripe_refund_id_key" ON "ordering"."refunds" ("stripe_refund_id") WHERE "stripe_refund_id" IS NOT NULL;

-- Grants. A refund is written once and only settles; its lines and its credit note are
-- insert-only. No row is deleted.
GRANT UPDATE ("refunded_amount") ON TABLE "ordering"."seller_orders" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("state", "stripe_refund_id", "attempts", "settled_at") ON TABLE "ordering"."refunds" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "ordering"."refund_lines" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "ordering"."credit_notes" TO "mondapac_app";
