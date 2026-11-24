-- Dashboards v2, phase 2: new and returning customers. At payment, ordering records whether the
-- paid seller order is the buyer's first paid order in the Market (`buyer_first_order`) and the
-- buyer's first paid order with this seller (`buyer_first_with_seller`), so reporting can count new
-- and returning customers without ever holding an account id.
--
-- Race-free by two claim tables: the unit that confirms a payment inserts one row per buyer and one
-- per buyer and seller with INSERT ... ON CONFLICT DO NOTHING, and the order the row names decides
-- the flags. Two concurrent first payments of one buyer meet on the primary key: the second waits
-- for the first to commit and then finds its row, so they cannot both be first. The flags are then
-- written once on the seller orders and never changed.
--
-- The claim rows hold the account id that `ordering.orders.account_id` already holds (a plain id,
-- no personal data). Customer erasure shreds the account's subject key and deletes no order; it
-- leaves these rows as it leaves the orders, and no erasure check reads them, so they are neither
-- a new re-identification path nor an erasure blocker.
--
-- History (bounded, set-based, same module): the claims are filled from the earliest paid order per
-- buyer and per buyer and seller (by payment time, ties by order id), and the flags of every paid
-- seller order from them. Like the `paid_at` backfill of 20261115230000 it runs in this file's
-- transaction: ADD COLUMN takes the table lock for the whole file, accepted while the table is small
-- (before launch). A payment confirmed by the previous release between this migration and the
-- deploy has no claim and keeps null flags (unknown); the confirming unit claims from the buyer's
-- earliest paid order, not from its own, so such a gap order still counts as the buyer's first and
-- a later order is never wrongly first.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable: nullable, no default: a catalog change only (no rewrite).
ALTER TABLE "ordering"."seller_orders" ADD COLUMN     "buyer_first_order" BOOLEAN,
ADD COLUMN     "buyer_first_with_seller" BOOLEAN;

-- CreateTable
CREATE TABLE "ordering"."buyer_first_orders" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "first_order_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "buyer_first_orders_pkey" PRIMARY KEY ("market_id","tenant_id","account_id")
);

-- CreateTable
CREATE TABLE "ordering"."buyer_first_seller_orders" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "first_order_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "buyer_first_seller_orders_pkey" PRIMARY KEY ("market_id","tenant_id","account_id","seller_id")
);

-- CreateIndex: the buyers whose first paid order falls in a period (new customers, phase plan).
CREATE INDEX "buyer_first_orders_market_id_first_order_at_idx" ON "ordering"."buyer_first_orders"("market_id", "first_order_at");

-- AddForeignKey: a claim names an order that exists; the four-column key keeps a seller claim's
-- order and seller those of its seller order. RESTRICT: orders are never deleted (erasure keeps them).
ALTER TABLE "ordering"."buyer_first_orders" ADD CONSTRAINT "buyer_first_orders_order_fkey" FOREIGN KEY ("market_id", "order_id") REFERENCES "ordering"."orders"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ordering"."buyer_first_seller_orders" ADD CONSTRAINT "buyer_first_seller_orders_seller_order_fkey" FOREIGN KEY ("market_id", "seller_order_id", "order_id", "seller_id") REFERENCES "ordering"."seller_orders"("market_id", "id", "order_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written.
ALTER TABLE "ordering"."buyer_first_orders"
  ADD CONSTRAINT "buyer_first_orders_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "buyer_first_orders_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

ALTER TABLE "ordering"."buyer_first_seller_orders"
  ADD CONSTRAINT "buyer_first_seller_orders_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "buyer_first_seller_orders_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

-- Backfill the claims from the orders already paid: the earliest paid order of each buyer, then of
-- each buyer and seller. Same order of the ties in both (payment time, then order id; one seller
-- order per seller and order), so a buyer's first order is always the first with each of its sellers.
-- Re-runnable (the database spec runs this part again): a claim already there is kept, and only
-- null flags are written, so no known flag is ever rewritten.
INSERT INTO "ordering"."buyer_first_orders" ("market_id", "tenant_id", "account_id", "order_id", "first_order_at")
SELECT DISTINCT ON (o."market_id", o."tenant_id", o."account_id")
       o."market_id", o."tenant_id", o."account_id", o."id", o."confirmed_at"
  FROM "ordering"."orders" AS o
 WHERE o."status" = 'confirmed'
 ORDER BY o."market_id", o."tenant_id", o."account_id", o."confirmed_at", o."id"
    ON CONFLICT DO NOTHING;

INSERT INTO "ordering"."buyer_first_seller_orders" ("market_id", "tenant_id", "account_id", "seller_id", "seller_order_id", "order_id", "first_order_at")
SELECT DISTINCT ON (o."market_id", o."tenant_id", o."account_id", s."seller_id")
       o."market_id", o."tenant_id", o."account_id", s."seller_id", s."id", o."id", o."confirmed_at"
  FROM "ordering"."orders" AS o
  JOIN "ordering"."seller_orders" AS s
    ON s."market_id" = o."market_id" AND s."order_id" = o."id"
 WHERE o."status" = 'confirmed'
 ORDER BY o."market_id", o."tenant_id", o."account_id", s."seller_id", o."confirmed_at", o."id"
    ON CONFLICT DO NOTHING;

-- The flags of every paid seller order, from the claims just written. Only null flags are set.
UPDATE "ordering"."seller_orders" AS s
   SET "buyer_first_order" = (f."order_id" = s."order_id"),
       "buyer_first_with_seller" = (fs."seller_order_id" = s."id")
  FROM "ordering"."orders" AS o,
       "ordering"."buyer_first_orders" AS f,
       "ordering"."buyer_first_seller_orders" AS fs
 WHERE o."market_id" = s."market_id"
   AND o."id" = s."order_id"
   AND o."status" = 'confirmed'
   AND s."paid_at" IS NOT NULL
   AND s."buyer_first_order" IS NULL
   AND f."market_id" = o."market_id"
   AND f."tenant_id" = o."tenant_id"
   AND f."account_id" = o."account_id"
   AND fs."market_id" = o."market_id"
   AND fs."tenant_id" = o."tenant_id"
   AND fs."account_id" = o."account_id"
   AND fs."seller_id" = s."seller_id";

-- Both flags or neither; only on a paid seller order; and a buyer's first order is always the first
-- with its seller. Checked after the backfill, in the same transaction.
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_buyer_first_check" CHECK (
    ("buyer_first_order" IS NULL AND "buyer_first_with_seller" IS NULL)
    OR ("buyer_first_order" IS NOT NULL
      AND "buyer_first_with_seller" IS NOT NULL
      AND "paid_at" IS NOT NULL
      AND (NOT "buyer_first_order" OR "buyer_first_with_seller"))
  );

-- Grants. The claims are inserted and read, never updated or deleted. The two flags are written
-- once by the confirming unit (`WHERE buyer_first_order IS NULL`).
GRANT SELECT, INSERT ON TABLE "ordering"."buyer_first_orders" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "ordering"."buyer_first_seller_orders" TO "mondapac_app";
GRANT UPDATE ("buyer_first_order", "buyer_first_with_seller") ON TABLE "ordering"."seller_orders" TO "mondapac_app";
