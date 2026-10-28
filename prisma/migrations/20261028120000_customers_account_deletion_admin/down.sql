-- Reverses 20261028120000_customers_account_deletion_admin: the grant, the checks, then the columns.
-- Accepted loss: an admin-cancelled row cannot keep the narrower cancel_reason check, so its reason
-- is mapped back to 'customer'; who cancelled it (cancelled_by_admin_id) and every admin-origin
-- column (admin, ticket reference, reason, redaction time) are dropped with the columns.
REVOKE UPDATE ("cancelled_by_admin_id", "reason", "redacted_at") ON TABLE "customers"."account_deletion_requests" FROM "mondapac_app";

ALTER TABLE "customers"."account_deletion_requests"
  DROP CONSTRAINT "account_deletion_requests_admin_cancel_check",
  DROP CONSTRAINT "account_deletion_requests_reason_check",
  DROP CONSTRAINT "account_deletion_requests_ticket_ref_check",
  DROP CONSTRAINT "account_deletion_requests_admin_columns_check",
  DROP CONSTRAINT "account_deletion_requests_requested_by_check",
  DROP CONSTRAINT "account_deletion_requests_cancel_reason_check";

UPDATE "customers"."account_deletion_requests" SET "cancel_reason" = 'customer' WHERE "cancel_reason" = 'admin';

ALTER TABLE "customers"."account_deletion_requests"
  ADD CONSTRAINT "account_deletion_requests_cancel_reason_check" CHECK ("cancel_reason" IN ('customer', 'sign-in')),
  DROP COLUMN "redacted_at",
  DROP COLUMN "cancelled_by_admin_id",
  DROP COLUMN "reason",
  DROP COLUMN "ticket_ref",
  DROP COLUMN "admin_account_id",
  DROP COLUMN "requested_by";
