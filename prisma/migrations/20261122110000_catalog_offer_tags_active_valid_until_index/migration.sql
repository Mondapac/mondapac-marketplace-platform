-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The dashboard's critical count of certification badges past their certificate's end
-- (dashboards upgrade, phase 1): the active Offer tags of every type on their validity end. Partial,
-- so it holds the active tags only. CONCURRENTLY: catalog.offer_tags holds rows, so the build takes
-- no write lock; it is alone in its file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "offer_tags_market_id_valid_until_active_idx" ON "catalog"."offer_tags" ("market_id", "valid_until") WHERE "status" = 'active';
