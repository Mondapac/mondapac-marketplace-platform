-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The admin Shipments and Invoices lists (Sales menu): when the seller order's order was paid
-- (confirmed), copied onto the seller order so that the lists filter and sort on
-- ordering.seller_orders alone, with no join to ordering.orders. Written in the unit that
-- confirms the order; null while the order is unpaid and on cancelled orders.
ALTER TABLE "ordering"."seller_orders"
    ADD COLUMN "paid_at" TIMESTAMPTZ(6);

-- Backfill from the orders already confirmed (same module, same Market).
UPDATE "ordering"."seller_orders" AS s
   SET "paid_at" = o."confirmed_at"
  FROM "ordering"."orders" AS o
 WHERE o."market_id" = s."market_id"
   AND o."id" = s."order_id"
   AND o."status" = 'confirmed'
   AND s."paid_at" IS NULL;

-- The admin Shipments list's Refunded stage: the seller order is refunded in full (its refunded
-- gross reached a positive total), as an admin cancellation leaves it. Kept by the refund unit
-- beside `refunded_amount`; the CHECK holds the two together, so a write that forgets it fails.
-- A constant default adds the column without rewriting the table.
ALTER TABLE "ordering"."seller_orders"
    ADD COLUMN "refunded_in_full" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ordering"."seller_orders"
   SET "refunded_in_full" = true
 WHERE "total_amount" > 0
   AND "refunded_amount" = "total_amount";

-- Hand-written.
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_refunded_in_full_check" CHECK ("refunded_in_full" = ("total_amount" > 0 AND "refunded_amount" = "total_amount"));

-- Grants. Both are set after insert: the payment time once by the confirming unit, the
-- refunded-in-full mark by the refund unit (raised with the refunded gross, lowered when a
-- refund fails).
GRANT UPDATE ("paid_at", "refunded_in_full") ON TABLE "ordering"."seller_orders" TO "mondapac_app";
