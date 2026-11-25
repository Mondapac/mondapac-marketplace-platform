-- Typical price read (offer page PR 9): the caps on the read get their own counter kinds, per
-- account (minute, day) and per seller (day), so reading prices never uses up a seller's
-- price-write allowance. Only the CHECK list of kinds widens; no data changes. One statement, so
-- the lock is taken once and the constraint is never absent.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

ALTER TABLE "pricing"."write_rate_counters"
  DROP CONSTRAINT "write_rate_counters_kind_check",
  ADD CONSTRAINT "write_rate_counters_kind_check" CHECK ("kind" IN
    ('typical.account.day', 'typical.account.minute', 'typical.seller.day',
     'write.account.day', 'write.account.minute'));
