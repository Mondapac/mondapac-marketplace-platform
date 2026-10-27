-- Reverses 20261027002000_customers_account_deletion_requests: the grant first, then the table.
REVOKE SELECT, INSERT, UPDATE ("status", "claimed_at", "cancelled_at", "cancel_reason", "completed_at")
  ON TABLE "customers"."account_deletion_requests" FROM "mondapac_app";

DROP TABLE "customers"."account_deletion_requests";
