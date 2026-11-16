-- CreateIndex. Hand-written partial index for the lapse of pending email changes (Mojtaba L1):
-- identity.purge-expired clears, per Market, the pending addresses asked for before a boundary.
-- Only accounts with a pending change are indexed. CONCURRENTLY: identity.accounts holds rows, so
-- the build takes no write lock; it is alone in its file because it cannot run inside a
-- transaction.
CREATE INDEX CONCURRENTLY "accounts_market_id_pending_email_requested_at_idx" ON "identity"."accounts" ("market_id", "pending_email_requested_at") WHERE "pending_email_requested_at" IS NOT NULL;
