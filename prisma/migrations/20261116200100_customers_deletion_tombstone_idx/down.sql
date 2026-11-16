-- Reverses 20261116200100_customers_deletion_tombstone_idx.
SET lock_timeout = '5s';

DROP INDEX IF EXISTS "customers"."account_deletion_requests_completed_idx";
