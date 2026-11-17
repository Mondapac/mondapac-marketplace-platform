-- Reverses 20261117050600_identity_customer_pending_email (after 20261117050601 is reversed).
-- Accepted loss: every email change in flight (pending address, its link) and every notice not
-- yet sent to a previous address are discarded; the customer keeps the current address, and an
-- unsent "your sign-in email was changed" notice is never sent.
SET lock_timeout = '5s';
REVOKE SELECT, INSERT, DELETE ON TABLE "identity"."email_change_notices" FROM "mondapac_app";
DROP TABLE "identity"."email_change_notices";
DELETE FROM "identity"."one_time_links" WHERE "purpose" = 'confirm-email-change';
ALTER TABLE "identity"."one_time_links" DROP CONSTRAINT "one_time_links_purpose_check";
ALTER TABLE "identity"."one_time_links"
  ADD CONSTRAINT "one_time_links_purpose_check" CHECK ("purpose" IN (
    'verify-email', 'reset-password', 'enrol-second-factor', 'confirm-second-factor-reset'));
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_pending_email_normalized_check";
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_pending_email_length_check";
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_pending_email_customer_check";
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_pending_email_check";
ALTER TABLE "identity"."accounts" DROP COLUMN "pending_email_requested_at";
ALTER TABLE "identity"."accounts" DROP COLUMN "pending_email_normalized";
ALTER TABLE "identity"."accounts" DROP COLUMN "pending_email";
