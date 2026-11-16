-- Reverses 20261116100000_identity_customer_pending_email.
SET lock_timeout = '5s';
DELETE FROM "identity"."one_time_links" WHERE "purpose" = 'confirm-email-change';
ALTER TABLE "identity"."one_time_links" DROP CONSTRAINT "one_time_links_purpose_check";
ALTER TABLE "identity"."one_time_links"
  ADD CONSTRAINT "one_time_links_purpose_check" CHECK ("purpose" IN (
    'verify-email', 'reset-password', 'enrol-second-factor', 'confirm-second-factor-reset'));
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_email_change_notice_check";
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_pending_email_normalized_check";
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_pending_email_length_check";
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_pending_email_customer_check";
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_pending_email_check";
ALTER TABLE "identity"."accounts" DROP COLUMN "email_change_notice";
ALTER TABLE "identity"."accounts" DROP COLUMN "pending_email_requested_at";
ALTER TABLE "identity"."accounts" DROP COLUMN "pending_email_normalized";
ALTER TABLE "identity"."accounts" DROP COLUMN "pending_email";
