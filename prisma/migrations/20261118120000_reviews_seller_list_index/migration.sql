-- Super list 32 (the shop's Reviews list): every page, view count and export of a shop reads its
-- published reviews by Market and seller, newest first. No index led with the seller, so each read
-- scanned the Market's published reviews. This partial index serves the default sort, the
-- published range and the counts. Partial, so Prisma's schema does not model it (as the other
-- partial indexes of the reviews schema).

SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE INDEX "product_reviews_seller_published_idx"
  ON "reviews"."product_reviews" ("market_id", "seller_id", "published_at" DESC, "id" DESC)
  WHERE "status" = 'published';
