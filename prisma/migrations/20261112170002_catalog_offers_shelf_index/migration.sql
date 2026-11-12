-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. Categories C9a, step 3: the Offers of one shelf, for the clear of a promoted or
-- merged shelf (catalog design 4.7). CONCURRENTLY: catalog.offers holds rows, so the build takes
-- no write lock; it is alone in its file because it cannot run inside a transaction (data design
-- 8.2; Mojtaba B1).
CREATE INDEX CONCURRENTLY "offers_market_id_shelf_category_id_idx" ON "catalog"."offers" ("market_id", "shelf_category_id") WHERE "shelf_category_id" IS NOT NULL;
