-- Reverses 20261125080000_pricing_typical_price_counters. The read counters are throwaway rate
-- windows, so they are deleted; nothing else is lost. Roll the code back first: while the new code
-- runs it can insert a read counter after the delete, and then the narrower CHECK fails (safe).
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

DELETE FROM "pricing"."write_rate_counters"
  WHERE "kind" IN ('typical.account.day', 'typical.account.minute', 'typical.seller.day');
ALTER TABLE "pricing"."write_rate_counters"
  DROP CONSTRAINT "write_rate_counters_kind_check",
  ADD CONSTRAINT "write_rate_counters_kind_check" CHECK ("kind" IN ('write.account.day', 'write.account.minute'));
