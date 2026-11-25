-- Reverses 20261125101500_reviews_market_published_index.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP INDEX IF EXISTS "reviews"."product_reviews_market_published_idx";
