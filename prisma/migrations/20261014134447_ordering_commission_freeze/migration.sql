-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable. The commission rate is frozen on each order line at placement (COM-04). Lines placed
-- before this migration keep no rate, and their seller orders never reach the seller ledger
-- (not-applicable); the default is dropped after the backfill.
ALTER TABLE "ordering"."order_lines" ADD COLUMN "commission_rate_bps" INTEGER;
ALTER TABLE "ordering"."seller_orders" ADD COLUMN "ledger_state" TEXT NOT NULL DEFAULT 'not-applicable';
ALTER TABLE "ordering"."seller_orders" ALTER COLUMN "ledger_state" DROP DEFAULT;
-- How many times the ledger refused the seller order: the worker takes the fewest first, so one
-- that keeps failing never blocks the others.
ALTER TABLE "ordering"."seller_orders" ADD COLUMN "ledger_attempts" INTEGER NOT NULL DEFAULT 0;

-- Hand-written: value checks.
ALTER TABLE "ordering"."order_lines"
  ADD CONSTRAINT "order_lines_commission_rate_bps_check" CHECK ("commission_rate_bps" IS NULL OR "commission_rate_bps" BETWEEN 0 AND 3000);
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_ledger_state_check" CHECK ("ledger_state" IN ('pending', 'recorded', 'not-applicable')),
  ADD CONSTRAINT "seller_orders_ledger_attempts_check" CHECK ("ledger_attempts" >= 0);

-- Hand-written: the worker's queue of seller orders not yet in the seller ledger. Invisible to Prisma.
CREATE INDEX "seller_orders_unrecorded_ledger_idx" ON "ordering"."seller_orders" ("market_id", "ledger_attempts", "order_id")
  WHERE "ledger_state" = 'pending';

-- Grants. The ledger state moves once, pending -> recorded, and the attempts only grow; the rate
-- never changes.
GRANT UPDATE ("ledger_attempts", "ledger_state") ON TABLE "ordering"."seller_orders" TO "mondapac_app";
