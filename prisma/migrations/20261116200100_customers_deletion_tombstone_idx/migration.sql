-- Customers management phase 2, PR 2b: the customer page answers a tombstone (id, deletedAt) for
-- an erased customer instead of not-found. It looks up the account's completed deletion request;
-- completed requests grow with every erasure, so the lookup gets its own small partial index.
-- Hand-written (Prisma cannot declare a partial index).
SET lock_timeout = '5s';

CREATE INDEX "account_deletion_requests_completed_idx"
  ON "customers"."account_deletion_requests" ("market_id", "account_id")
  WHERE "status" = 'completed';
