-- Safety (docs/design/data/pricing.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Hand-written (database-designer): pricing-data 6.2, the review queue of held regular prices,
-- oldest first (PD5; migration 5 of the plan, queue index only). Partial on the pending status,
-- so it holds the held records only (about 1% of the table). Invisible to Prisma, like the other
-- partial indexes; checked by the partial-index catalog test. The "latest approved" index of the
-- same migration waits for the first reader that needs it.
CREATE INDEX "regular_price_records_market_id_submitted_at_id_pending_idx"
  ON "pricing"."regular_price_records" ("market_id", "submitted_at", "id")
  WHERE "status" = 'pending-review';
