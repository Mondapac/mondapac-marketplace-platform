-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

DROP INDEX "payments"."disputes_market_id_order_id_idx";
