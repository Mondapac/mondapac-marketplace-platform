-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ordering";

-- CreateTable
CREATE TABLE "ordering"."orders" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "cancel_reason" TEXT,
    "payment_state" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "total_amount" BIGINT NOT NULL,
    "reservation_id" UUID NOT NULL,
    "stripe_idempotency_key" TEXT NOT NULL,
    "stripe_session_id" TEXT,
    "stripe_payment_intent_id" TEXT,
    "payment_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordering"."seller_orders" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "subtotal_amount" BIGINT NOT NULL,
    "shipping_amount" BIGINT NOT NULL,
    "total_amount" BIGINT NOT NULL,

    CONSTRAINT "seller_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordering"."order_lines" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_amount" BIGINT NOT NULL,
    "line_amount" BIGINT NOT NULL,
    "tax_inclusive" BOOLEAN NOT NULL,
    "reservation_line_id" UUID NOT NULL,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "orders_market_id_account_id_created_at_idx" ON "ordering"."orders"("market_id", "account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_market_id_status_created_at_idx" ON "ordering"."orders"("market_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "orders_market_id_stripe_idempotency_key_key" ON "ordering"."orders"("market_id", "stripe_idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "orders_market_id_id_key" ON "ordering"."orders"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_orders_market_id_id_key" ON "ordering"."seller_orders"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "seller_orders_market_id_order_id_seller_id_key" ON "ordering"."seller_orders"("market_id", "order_id", "seller_id");

-- CreateIndex
CREATE INDEX "order_lines_market_id_order_id_idx" ON "ordering"."order_lines"("market_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_lines_market_id_order_id_offer_id_variant_id_key" ON "ordering"."order_lines"("market_id", "order_id", "offer_id", "variant_id");

-- AddForeignKey
ALTER TABLE "ordering"."seller_orders" ADD CONSTRAINT "seller_orders_market_id_order_id_fkey" FOREIGN KEY ("market_id", "order_id") REFERENCES "ordering"."orders"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordering"."order_lines" ADD CONSTRAINT "order_lines_market_id_order_id_fkey" FOREIGN KEY ("market_id", "order_id") REFERENCES "ordering"."orders"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordering"."order_lines" ADD CONSTRAINT "order_lines_market_id_seller_order_id_fkey" FOREIGN KEY ("market_id", "seller_order_id") REFERENCES "ordering"."seller_orders"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: scope and value checks.
ALTER TABLE "ordering"."orders"
  ADD CONSTRAINT "orders_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "orders_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "orders_status_check" CHECK ("status" IN ('pending-payment', 'confirmed', 'cancelled')),
  ADD CONSTRAINT "orders_cancel_reason_check" CHECK (
    ("status" = 'cancelled' AND "cancel_reason" IS NOT NULL AND "cancel_reason" IN
      ('expired', 'payment-failed', 'stock-unavailable', 'superseded', 'provider-failed')
      AND "cancelled_at" IS NOT NULL)
    OR ("status" <> 'cancelled' AND "cancel_reason" IS NULL AND "cancelled_at" IS NULL)),
  ADD CONSTRAINT "orders_confirmed_check" CHECK (("status" = 'confirmed') = ("confirmed_at" IS NOT NULL)),
  ADD CONSTRAINT "orders_payment_state_check" CHECK (
    "payment_state" IN ('none', 'authorised', 'captured', 'voided')),
  ADD CONSTRAINT "orders_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "orders_total_check" CHECK ("total_amount" > 0),
  ADD CONSTRAINT "orders_version_check" CHECK ("version" >= 1);

ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_orders_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_orders_amounts_check" CHECK (
    "subtotal_amount" >= 0 AND "shipping_amount" >= 0
    AND "total_amount" = "subtotal_amount" + "shipping_amount");

ALTER TABLE "ordering"."order_lines"
  ADD CONSTRAINT "order_lines_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "order_lines_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "order_lines_quantity_check" CHECK ("quantity" BETWEEN 1 AND 999),
  ADD CONSTRAINT "order_lines_amounts_check" CHECK (
    "unit_amount" >= 0 AND "line_amount" = "unit_amount" * "quantity");

-- Hand-written: one Checkout session and one PaymentIntent belong to one order. Invisible to Prisma.
CREATE UNIQUE INDEX "orders_stripe_session_id_key" ON "ordering"."orders" ("stripe_session_id") WHERE "stripe_session_id" IS NOT NULL;
CREATE UNIQUE INDEX "orders_stripe_payment_intent_id_key" ON "ordering"."orders" ("stripe_payment_intent_id") WHERE "stripe_payment_intent_id" IS NOT NULL;

-- Grants. The application inserts orders and moves their state; it never deletes a row, and the
-- lines and seller orders are written once.
GRANT USAGE ON SCHEMA "ordering" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "cancel_reason", "payment_state", "stripe_session_id", "stripe_payment_intent_id", "confirmed_at", "cancelled_at", "version") ON TABLE "ordering"."orders" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "ordering"."seller_orders" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "ordering"."order_lines" TO "mondapac_app";
