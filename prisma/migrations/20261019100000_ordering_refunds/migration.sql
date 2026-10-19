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
    "seller_order_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "line_quantity" INTEGER NOT NULL,
    "units_before" INTEGER NOT NULL,
    "gross_amount" BIGINT NOT NULL,
    "tax_amount" BIGINT NOT NULL,
    "tax_rate_bps" INTEGER NOT NULL,
    "tax_inclusive" BOOLEAN NOT NULL,

    CONSTRAINT "refund_lines_pkey" PRIMARY KEY ("market_id","refund_id","order_line_id")
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
CREATE UNIQUE INDEX "refunds_market_id_id_key" ON "ordering"."refunds"("market_id", "id");

-- CreateIndex. The foreign-key target of the refund lines and the credit note (Mojtaba 4).
CREATE UNIQUE INDEX "refunds_market_id_id_seller_order_id_key" ON "ordering"."refunds"("market_id", "id", "seller_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_market_id_stripe_idempotency_key_key" ON "ordering"."refunds"("market_id", "stripe_idempotency_key");

-- CreateIndex. Serves no query: it only keeps the order-line foreign key cheap to check.
CREATE INDEX "refund_lines_market_id_order_line_id_idx" ON "ordering"."refund_lines"("market_id", "order_line_id");

-- CreateIndex
CREATE INDEX "credit_notes_market_id_seller_order_id_idx" ON "ordering"."credit_notes"("market_id", "seller_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_market_id_refund_id_key" ON "ordering"."credit_notes"("market_id", "refund_id");

-- CreateIndex. The key of the credit note's one-to-one refund relation (the pair above is unique).
CREATE UNIQUE INDEX "credit_notes_market_id_refund_id_seller_order_id_key" ON "ordering"."credit_notes"("market_id", "refund_id", "seller_order_id");

-- CreateIndex. The foreign-key targets of the refund lines (Mojtaba 3, Hassan L2) and of the
-- refunds (Mojtaba 4); the ids are already primary keys. Not CONCURRENTLY although both tables
-- may hold rows: no deployed environment holds any yet (catalog data design 8.2); a deployed one
-- would build each CONCURRENTLY, alone in its file.
CREATE UNIQUE INDEX "order_lines_market_id_id_seller_order_id_quantity_key" ON "ordering"."order_lines"("market_id", "id", "seller_order_id", "quantity");
CREATE UNIQUE INDEX "seller_orders_market_id_id_order_id_seller_id_key" ON "ordering"."seller_orders"("market_id", "id", "order_id", "seller_id");

-- AddForeignKey
ALTER TABLE "ordering"."refunds" ADD CONSTRAINT "refunds_market_id_seller_order_id_order_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_order_id", "order_id", "seller_id") REFERENCES "ordering"."seller_orders"("market_id", "id", "order_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordering"."refund_lines" ADD CONSTRAINT "refund_lines_market_id_refund_id_seller_order_id_fkey" FOREIGN KEY ("market_id", "refund_id", "seller_order_id") REFERENCES "ordering"."refunds"("market_id", "id", "seller_order_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordering"."refund_lines" ADD CONSTRAINT "refund_lines_market_id_order_line_id_seller_order_id_line__fkey" FOREIGN KEY ("market_id", "order_line_id", "seller_order_id", "line_quantity") REFERENCES "ordering"."order_lines"("market_id", "id", "seller_order_id", "quantity") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ordering"."credit_notes" ADD CONSTRAINT "credit_notes_market_id_refund_id_seller_order_id_fkey" FOREIGN KEY ("market_id", "refund_id", "seller_order_id") REFERENCES "ordering"."refunds"("market_id", "id", "seller_order_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: a seller order never gives back more than it took. Every existing row holds 0.
-- VALIDATE runs in the same transaction as NOT VALID, so the shorter lock is not gained; the
-- project accepts that until a deployed environment exists (Mojtaba 6).
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
    "reason" IN ('not-received', 'damaged', 'wrong-item', 'not-as-described', 'seller-cancelled', 'other')),
  -- Only an admin refunds (ordering design 97; Hassan H1).
  ADD CONSTRAINT "refunds_actor_population_check" CHECK ("actor_population" = 'admin'),
  -- A pending refund may already hold Stripe's id (Stripe made it, not final yet); so may a failed
  -- one (Stripe made it and it failed; Mojtaba 9). A succeeded one always does.
  ADD CONSTRAINT "refunds_state_check" CHECK (
    ("state" = 'pending' AND "settled_at" IS NULL)
    OR ("state" = 'succeeded' AND "settled_at" IS NOT NULL AND "stripe_refund_id" IS NOT NULL)
    OR ("state" = 'failed' AND "settled_at" IS NOT NULL)),
  ADD CONSTRAINT "refunds_stripe_refund_id_check" CHECK (
    "stripe_refund_id" IS NULL OR "stripe_refund_id" ~ '^re_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "refunds_attempts_check" CHECK ("attempts" >= 0);

ALTER TABLE "ordering"."refund_lines"
  ADD CONSTRAINT "refund_lines_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "refund_lines_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- Never more units than the line has (line_quantity is proven by the foreign key; Mojtaba 3).
  -- Units across several refunds stay an application rule (units_before).
  ADD CONSTRAINT "refund_lines_quantity_check" CHECK (
    "quantity" >= 1 AND "line_quantity" BETWEEN 1 AND 999 AND "units_before" >= 0
    AND "units_before" + "quantity" <= "line_quantity"),
  ADD CONSTRAINT "refund_lines_amounts_check" CHECK (
    "gross_amount" > 0 AND "tax_amount" >= 0 AND "tax_amount" <= "gross_amount"),
  ADD CONSTRAINT "refund_lines_tax_rate_check" CHECK ("tax_rate_bps" BETWEEN 0 AND 5000);

ALTER TABLE "ordering"."credit_notes"
  ADD CONSTRAINT "credit_notes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "credit_notes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "credit_notes_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "credit_notes_amounts_check" CHECK (
    "gross_amount" > 0 AND "tax_amount" >= 0 AND "tax_amount" <= "gross_amount");

-- Hand-written: at most one pending refund per seller order, one Stripe refund belongs to one
-- refund, and the worker's read of pending refunds, oldest first (Mojtaba 8). Invisible to Prisma.
CREATE UNIQUE INDEX "refunds_one_pending_key" ON "ordering"."refunds" ("market_id", "seller_order_id") WHERE "state" = 'pending';
CREATE UNIQUE INDEX "refunds_stripe_refund_id_key" ON "ordering"."refunds" ("stripe_refund_id") WHERE "stripe_refund_id" IS NOT NULL;
CREATE INDEX "refunds_pending_requested_at_idx" ON "ordering"."refunds" ("market_id", "requested_at", "id") WHERE "state" = 'pending';

-- Hand-written guard (Hassan M2; the rules of catalog data design 5.1: SECURITY INVOKER, a fixed
-- search_path, schema-qualified names, no dynamic EXECUTE). A refund settles once: only a pending
-- one changes, attempts only grow, and Stripe's id, once kept, never changes (23514).
CREATE FUNCTION "ordering"."refunds_settle_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."state" <> 'pending' THEN
    RAISE EXCEPTION 'ordering.refunds: a settled refund never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'ordering.refunds: attempts only grow' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."stripe_refund_id" IS NOT NULL
     AND NEW."stripe_refund_id" IS DISTINCT FROM OLD."stripe_refund_id" THEN
    RAISE EXCEPTION 'ordering.refunds: the Stripe refund id never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "refunds_settle_guard" BEFORE UPDATE ON "ordering"."refunds"
  FOR EACH ROW EXECUTE FUNCTION "ordering"."refunds_settle_guard"();

-- Hand-written guard (Hassan M2): at commit, a seller order's refunded sum is exactly the gross of
-- its refunds that have not failed, so the app cannot raise or lower it on its own (23514).
-- Deferred: a refund raises the sum before its row is inserted, in one unit.
CREATE FUNCTION "ordering"."seller_orders_refunded_matches"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  seller_order UUID;
  stored BIGINT;
  summed BIGINT;
BEGIN
  -- A field of the other table would not compile, so each table reads its own.
  IF TG_TABLE_NAME = 'seller_orders' THEN
    seller_order := NEW."id";
  ELSE
    seller_order := NEW."seller_order_id";
  END IF;
  SELECT so."refunded_amount" INTO stored FROM "ordering"."seller_orders" so
    WHERE so."market_id" = NEW."market_id" AND so."id" = seller_order;
  SELECT COALESCE(SUM(r."gross_amount"), 0) INTO summed FROM "ordering"."refunds" r
    WHERE r."market_id" = NEW."market_id" AND r."seller_order_id" = seller_order
      AND r."state" <> 'failed';
  IF stored IS DISTINCT FROM summed THEN
    RAISE EXCEPTION 'ordering.seller_orders: refunded_amount differs from its refunds'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "seller_orders_refunded_matches" AFTER UPDATE OF "refunded_amount"
  ON "ordering"."seller_orders" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ordering"."seller_orders_refunded_matches"();
CREATE CONSTRAINT TRIGGER "refunds_refunded_matches" AFTER INSERT OR UPDATE OF "state"
  ON "ordering"."refunds" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ordering"."seller_orders_refunded_matches"();

-- Grants. A refund is written once and only settles; its lines and its credit note are
-- insert-only. No row is deleted.
GRANT UPDATE ("refunded_amount") ON TABLE "ordering"."seller_orders" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("state", "stripe_refund_id", "attempts", "settled_at") ON TABLE "ordering"."refunds" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "ordering"."refund_lines" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "ordering"."credit_notes" TO "mondapac_app";
