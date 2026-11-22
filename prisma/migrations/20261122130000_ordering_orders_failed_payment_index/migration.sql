-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The dashboard's count of orders whose payment failed (dashboards upgrade, phase 1):
-- the cancellations for a failed payment on their time. Partial, so it holds those orders only, not
-- the expired checkouts; CONCURRENTLY: ordering.orders holds rows, so the build takes no write lock,
-- and it is alone in its file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "orders_market_id_cancelled_at_failed_payment_idx" ON "ordering"."orders" ("market_id", "cancelled_at") WHERE "status" = 'cancelled' AND "cancel_reason" IN ('payment-failed', 'provider-failed');
