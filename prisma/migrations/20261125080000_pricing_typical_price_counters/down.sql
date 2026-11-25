-- Reverses 20261125080000_pricing_typical_price_counters. The read counters are throwaway rate
-- windows, so they are deleted; nothing else is lost.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

DELETE FROM "pricing"."write_rate_counters" WHERE "kind" LIKE 'typical.%';
ALTER TABLE "pricing"."write_rate_counters" DROP CONSTRAINT "write_rate_counters_kind_check";
ALTER TABLE "pricing"."write_rate_counters"
  ADD CONSTRAINT "write_rate_counters_kind_check" CHECK ("kind" IN ('write.account.day', 'write.account.minute'));
