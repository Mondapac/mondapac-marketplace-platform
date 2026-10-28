-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "customers"."account_deletion_requests"
  ADD COLUMN "requested_by" TEXT NOT NULL DEFAULT 'customer',
  ADD COLUMN "admin_account_id" UUID,
  ADD COLUMN "ticket_ref" VARCHAR(64),
  ADD COLUMN "reason" VARCHAR(500),
  ADD COLUMN "cancelled_by_admin_id" UUID,
  ADD COLUMN "cancel_note" VARCHAR(500);

-- Hand-written: who asked. A buyer's request carries none of the admin columns; an admin's carries
-- the admin, a ticket reference and a reason (admin-entered text: never in events or audit rows).
ALTER TABLE "customers"."account_deletion_requests"
  ADD CONSTRAINT "account_deletion_requests_requested_by_check" CHECK ("requested_by" IN ('customer', 'admin')),
  ADD CONSTRAINT "account_deletion_requests_admin_columns_check" CHECK (
    ("requested_by" = 'customer' AND "admin_account_id" IS NULL AND "ticket_ref" IS NULL AND "reason" IS NULL)
    OR ("requested_by" = 'admin' AND "admin_account_id" IS NOT NULL AND "ticket_ref" IS NOT NULL AND "reason" IS NOT NULL)
  ),
  ADD CONSTRAINT "account_deletion_requests_ticket_ref_check" CHECK ("ticket_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._#/-]{0,63}$'),
  ADD CONSTRAINT "account_deletion_requests_reason_check" CHECK (char_length("reason") BETWEEN 1 AND 500),
  ADD CONSTRAINT "account_deletion_requests_cancel_note_check" CHECK (char_length("cancel_note") BETWEEN 1 AND 500);

-- Hand-written: an admin cancel names the admin and the note, no other cancel carries either.
ALTER TABLE "customers"."account_deletion_requests"
  DROP CONSTRAINT "account_deletion_requests_cancel_reason_check",
  ADD CONSTRAINT "account_deletion_requests_cancel_reason_check" CHECK ("cancel_reason" IN ('customer', 'sign-in', 'admin')),
  ADD CONSTRAINT "account_deletion_requests_admin_cancel_check" CHECK (
    ("cancel_reason" = 'admin' AND "cancelled_by_admin_id" IS NOT NULL AND "cancel_note" IS NOT NULL)
    OR (("cancel_reason" IS NULL OR "cancel_reason" <> 'admin') AND "cancelled_by_admin_id" IS NULL AND "cancel_note" IS NULL)
  );

-- Grant: the application may also set the two admin cancel columns when it cancels (the insert
-- grant is table-wide and already covers the new request columns).
GRANT UPDATE ("cancelled_by_admin_id", "cancel_note") ON TABLE "customers"."account_deletion_requests" TO "mondapac_app";
