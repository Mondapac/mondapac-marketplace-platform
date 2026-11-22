-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The dashboard's count of failed webhooks (dashboards upgrade, phase 1): the Stripe
-- events given up, on their receipt. Partial, so it holds the failed events only; CONCURRENTLY:
-- payments.stripe_events holds rows, so the build takes no write lock, and it is alone in its file
-- because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "stripe_events_market_id_received_at_failed_idx" ON "payments"."stripe_events" ("market_id", "received_at") WHERE "outcome" = 'failed';
