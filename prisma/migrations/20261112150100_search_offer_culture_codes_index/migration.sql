-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateIndex. The culture filter of package 3b asks for documents holding one of the chosen codes
-- (`culture_codes && $1`; `@>` for one code). CONCURRENTLY: search.offer_documents holds rows, so
-- the build takes no write lock; it is alone in its file because it cannot run inside a transaction.
CREATE INDEX CONCURRENTLY "offer_documents_culture_codes_idx" ON "search"."offer_documents" USING GIN ("culture_codes");
