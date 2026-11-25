-- Typical price read (offer page PR 9): the per-account cap on the read gets its own two counter
-- kinds, so reading prices never uses up a seller's price-write allowance. Only the CHECK list of
-- kinds widens; no data changes.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

ALTER TABLE "pricing"."write_rate_counters" DROP CONSTRAINT "write_rate_counters_kind_check";
ALTER TABLE "pricing"."write_rate_counters"
  ADD CONSTRAINT "write_rate_counters_kind_check" CHECK ("kind" IN
    ('typical.account.day', 'typical.account.minute', 'write.account.day', 'write.account.minute'));
