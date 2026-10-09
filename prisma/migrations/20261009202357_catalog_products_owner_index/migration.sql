-- Safety (docs/design/data/catalog.md 8.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex
CREATE INDEX "products_market_id_owner_seller_id_id_idx" ON "catalog"."products"("market_id", "owner_seller_id", "id");
