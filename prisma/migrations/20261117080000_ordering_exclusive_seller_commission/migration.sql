-- Customers management phase 4b: the lower commission for a seller's exclusive customer. Checkout
-- freezes on each order line whether the buyer was the exclusive customer of the line's seller and
-- why the line carries its rate. Both columns have a constant default, so existing lines are not
-- rewritten: they are `standard`, not exclusive (true: nothing was lowered before this).
SET lock_timeout = '5s';

ALTER TABLE "ordering"."order_lines"
  ADD COLUMN "commission_rate_reason" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN "exclusive_seller" BOOLEAN NOT NULL DEFAULT false;

-- Hand-written: value checks. A lowered rate is only ever on a line of the buyer's exclusive
-- seller, and only on a line that has a frozen rate.
ALTER TABLE "ordering"."order_lines"
  ADD CONSTRAINT "order_lines_commission_rate_reason_check" CHECK (
    "commission_rate_reason" IN ('standard', 'exclusive')
    AND ("commission_rate_reason" = 'standard'
      OR ("exclusive_seller" AND "commission_rate_bps" IS NOT NULL)));

-- Grants: unchanged. The app role inserts lines (table-level INSERT) and never updates these.
