-- Reverses 20261118120000_reviews_seller_list_index.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DROP INDEX "reviews"."product_reviews_seller_published_idx";
