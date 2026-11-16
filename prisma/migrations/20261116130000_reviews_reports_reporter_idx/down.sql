-- Reverses 20261116130000_reviews_reports_reporter_idx.
SET lock_timeout = '5s';

DROP INDEX IF EXISTS "reviews"."review_reports_market_id_reporter_account_id_created_at_idx";
