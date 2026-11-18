-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Customers management phase 2b, part 3 (the customer page's reviews sections): the reports one
-- account made, read by (market, reporter) newest first. Reports are rare (one per reporter and
-- review, sellers only) and no deployed environment holds them, so the index is built in the
-- migration's own transaction (a live table with more than about 10^5 rows would take
-- `CREATE INDEX CONCURRENTLY`, alone in its file).
-- CreateIndex
CREATE INDEX "review_reports_market_id_reporter_account_id_created_at_idx" ON "reviews"."review_reports"("market_id", "reporter_account_id", "created_at" DESC);
