-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "customers"."account_deletion_requests"
  ADD COLUMN "requested_by" TEXT NOT NULL DEFAULT 'customer',
  ADD COLUMN "admin_account_id" UUID,
  ADD COLUMN "ticket_ref" VARCHAR(64),
  ADD COLUMN "reason" VARCHAR(500),
  ADD COLUMN "cancelled_by_admin_id" UUID,
  ADD COLUMN "redacted_at" TIMESTAMPTZ(6);

-- Hand-written: who asked. A buyer's request carries none of the admin columns. An admin's carries
-- the admin and a ticket reference, and a reason while it is open; the reason is admin-entered free
-- text that may hold personal data, so it is set to NULL, with `redacted_at`, when the request is
-- closed (cancelled or completed). The ticket reference is kept. Never in events or audit rows.
ALTER TABLE "customers"."account_deletion_requests"
  ADD CONSTRAINT "account_deletion_requests_requested_by_check" CHECK ("requested_by" IN ('customer', 'admin')),
  ADD CONSTRAINT "account_deletion_requests_admin_columns_check" CHECK (
    ("requested_by" = 'customer' AND "admin_account_id" IS NULL AND "ticket_ref" IS NULL AND "reason" IS NULL AND "redacted_at" IS NULL)
    OR ("requested_by" = 'admin' AND "admin_account_id" IS NOT NULL AND "ticket_ref" IS NOT NULL AND (
      ("redacted_at" IS NULL AND "reason" IS NOT NULL)
      OR ("redacted_at" IS NOT NULL AND "reason" IS NULL AND "status" IN ('cancelled', 'completed'))
    ))
  ),
  ADD CONSTRAINT "account_deletion_requests_admin_closed_check" CHECK (
    NOT ("requested_by" = 'admin' AND "status" IN ('cancelled', 'completed'))
    OR ("redacted_at" IS NOT NULL AND "reason" IS NULL)
  ),
  ADD CONSTRAINT "account_deletion_requests_redacted_at_check" CHECK ("redacted_at" IS NULL OR "redacted_at" >= "requested_at"),
  ADD CONSTRAINT "account_deletion_requests_ticket_ref_check" CHECK ("ticket_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._#/-]{0,63}$'),
  ADD CONSTRAINT "account_deletion_requests_reason_check" CHECK (char_length("reason") BETWEEN 1 AND 500);

-- Hand-written: an admin cancel names the admin; no other cancel carries one. (The admin's cancel
-- note is validated and audited by the admin's id only: it is never stored.)
ALTER TABLE "customers"."account_deletion_requests"
  DROP CONSTRAINT "account_deletion_requests_cancel_reason_check",
  ADD CONSTRAINT "account_deletion_requests_cancel_reason_check" CHECK ("cancel_reason" IN ('customer', 'sign-in', 'admin')),
  ADD CONSTRAINT "account_deletion_requests_admin_cancel_check" CHECK (
    ("cancel_reason" = 'admin' AND "cancelled_by_admin_id" IS NOT NULL)
    OR (("cancel_reason" IS NULL OR "cancel_reason" <> 'admin') AND "cancelled_by_admin_id" IS NULL)
  );

-- Grant: the application may also set the admin cancel column and redact (reason, redacted_at) when
-- it closes a request (the insert grant is table-wide and already covers the new request columns).
GRANT UPDATE ("cancelled_by_admin_id", "reason", "redacted_at") ON TABLE "customers"."account_deletion_requests" TO "mondapac_app";

-- Hand-written: the columns the application may update are not enough to protect the evidence, so a
-- trigger holds the rest. `reason` may only go from a value to NULL, in the same statement that sets
-- `redacted_at` (once); the ticket reference, who asked and the asking admin never change.
CREATE FUNCTION "customers"."account_deletion_requests_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."ticket_ref" IS DISTINCT FROM OLD."ticket_ref"
     OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
     OR NEW."admin_account_id" IS DISTINCT FROM OLD."admin_account_id" THEN
    RAISE EXCEPTION 'customers.account_deletion_requests: ticket_ref, requested_by and admin_account_id never change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."redacted_at" IS DISTINCT FROM OLD."redacted_at"
     AND (OLD."redacted_at" IS NOT NULL OR NEW."redacted_at" IS NULL) THEN
    RAISE EXCEPTION 'customers.account_deletion_requests: redacted_at is set once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."reason" IS DISTINCT FROM OLD."reason"
     AND NOT (NEW."reason" IS NULL AND NEW."redacted_at" IS NOT NULL AND OLD."redacted_at" IS NULL) THEN
    RAISE EXCEPTION 'customers.account_deletion_requests: reason can only be redacted (set to NULL with redacted_at)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "account_deletion_requests_guard" BEFORE UPDATE ON "customers"."account_deletion_requests"
  FOR EACH ROW EXECUTE FUNCTION "customers"."account_deletion_requests_guard"();
