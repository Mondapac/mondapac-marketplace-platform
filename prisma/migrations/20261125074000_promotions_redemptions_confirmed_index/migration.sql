-- CreateIndex. Hand-written partial index for the admin dashboard's discount cost (dashboards v2,
-- phase 2; promotions.sum-discount-cost): the redemptions whose order's payment was confirmed in a
-- window of Market days, head rows included (they count the orders), summed by kind and status.
-- RESERVED rows never have a confirmation, so they are not in it. CONCURRENTLY: promotions.redemptions
-- holds rows and takes writes at every checkout, so the build takes no write lock; it is alone in its
-- file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "redemptions_confirmed_idx" ON "promotions"."redemptions" ("market_id", "confirmed_at") WHERE "confirmed_at" IS NOT NULL;
