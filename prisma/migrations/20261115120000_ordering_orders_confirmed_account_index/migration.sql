-- CreateIndex. Hand-written partial index for the customers read model (customers phase 1, B1):
-- the totals of one account's confirmed orders and the keyset walk over the accounts that have
-- one (customers.reconcile-read-models). CONCURRENTLY: ordering.orders holds rows, so the build
-- takes no write lock; it is alone in its file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "orders_market_id_account_id_confirmed_idx" ON "ordering"."orders" ("market_id", "account_id") WHERE "status" = 'confirmed';
