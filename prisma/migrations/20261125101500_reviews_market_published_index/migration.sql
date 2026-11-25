-- Dashboards v2, phase 2: the admin dashboard counts the reviews the whole Market published in the
-- last 30 Market days and the 30 before (reviews.count-market-reviews, grouped by rating). Every
-- existing partial index of published reviews leads with a product or a seller, so that read
-- would scan the Market's published reviews. This partial index serves it by Market and
-- publication time. Partial, so Prisma's schema does not model it (as the other partial indexes
-- of the reviews schema). Built with the table's lock as the other reviews indexes are: the
-- reviews table is small next to orders, and the build is bounded by the statement timeout.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE INDEX "product_reviews_market_published_idx"
  ON "reviews"."product_reviews" ("market_id", "published_at")
  WHERE "status" = 'published';
