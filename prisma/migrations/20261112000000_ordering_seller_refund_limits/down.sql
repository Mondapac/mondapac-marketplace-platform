-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261112000000_ordering_seller_refund_limits: the caps an admin set and the guard
-- rows go; with no cap in force the seller path refuses every request until they are set again.
DROP INDEX "ordering"."refunds_market_id_seller_id_requested_at_idx";
DROP TABLE "ordering"."seller_refund_guards";
DROP TABLE "ordering"."seller_refund_limits";
