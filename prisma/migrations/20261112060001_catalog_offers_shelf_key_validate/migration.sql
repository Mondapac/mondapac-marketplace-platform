SET lock_timeout = '5s';
SET statement_timeout = '15min';

-- Categories C9a, step 2: validate the same-seller shelf key of offers, added NOT VALID in
-- 20261112060000. In its own file so it takes only SHARE UPDATE EXCLUSIVE on offers and on
-- seller_categories: reads and writes of offers go on while it scans (data design 8.2; Mojtaba B1).
-- The column is all NULL here, so the scan finds nothing to check.
ALTER TABLE "catalog"."offers" VALIDATE CONSTRAINT "offers_market_id_shelf_category_id_seller_id_fkey";
