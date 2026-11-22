-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The dashboard's review count of manufacturer certificates waiting for review
-- (dashboards upgrade, phase 1): the certificates that name a pending revision. Partial, so it
-- holds the waiting certificates only; without it the count reads every certificate of the
-- Market. CONCURRENTLY: certification.product_certifications holds rows, so the build takes no
-- write lock; it is alone in its file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "product_certifications_market_id_pending_idx" ON "certification"."product_certifications" ("market_id") INCLUDE ("pending_revision_id") WHERE "pending_revision_id" IS NOT NULL;
