-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- An admin changes a customer's sign-in email (customers admin email change; design note of
-- 16 Nov 2026 with Mohammad's and Hassan's reviews). The new address waits on the account as the
-- pending address until the customer confirms it from that mailbox with the account's password;
-- the account keeps signing in with the current one until then. Three nullable columns, set and
-- cleared together (accounts_pending_email_check), for customer accounts only. The pending address
-- is not unique: two accounts may wait for the same one, and the unique index on
-- (market_id, population, email_normalized) decides at the confirmation (the clash rolls the
-- confirmation back). email_change_notice holds the previous address sealed under the account's
-- subject key (a "v1." envelope) between the confirmation and the notice mailed to it; erasure
-- destroys the key, so the value becomes unreadable with the rest of the account (Hassan R11).
-- Nullable columns without a default: a metadata-only change; every existing row passes the
-- CHECKs (the columns are new). They validate under the ALTER's lock, as
-- 20261021180000_identity_customer_storefront_appearance. accounts already has the table UPDATE
-- grant for mondapac_app (20261007222007_identity_accounts): no grant changes.
ALTER TABLE "identity"."accounts" ADD COLUMN "pending_email" TEXT;
ALTER TABLE "identity"."accounts" ADD COLUMN "pending_email_normalized" TEXT;
ALTER TABLE "identity"."accounts" ADD COLUMN "pending_email_requested_at" TIMESTAMPTZ(6);
ALTER TABLE "identity"."accounts" ADD COLUMN "email_change_notice" TEXT;

ALTER TABLE "identity"."accounts"
  ADD CONSTRAINT "accounts_pending_email_check" CHECK (
    ("pending_email" IS NULL) = ("pending_email_normalized" IS NULL)
    AND ("pending_email" IS NULL) = ("pending_email_requested_at" IS NULL)),
  ADD CONSTRAINT "accounts_pending_email_customer_check"
    CHECK (("pending_email" IS NULL AND "email_change_notice" IS NULL) OR "population" = 'customer'),
  -- The same rules as accounts_email_check and accounts_email_normalized_check.
  ADD CONSTRAINT "accounts_pending_email_length_check"
    CHECK ("pending_email" IS NULL OR char_length("pending_email") BETWEEN 3 AND 254),
  ADD CONSTRAINT "accounts_pending_email_normalized_check" CHECK (
    "pending_email_normalized" IS NULL OR (
      "pending_email_normalized" = lower("pending_email_normalized" COLLATE "C")
      AND "pending_email_normalized" = btrim("pending_email_normalized")
      AND "pending_email_normalized" IS NFC NORMALIZED)),
  ADD CONSTRAINT "accounts_email_change_notice_check"
    CHECK ("email_change_notice" IS NULL OR (
      "email_change_notice" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
      AND char_length("email_change_notice") BETWEEN 41 AND 2048));

-- The new link purpose: the confirmation of a changed sign-in email, mailed to the pending address.
ALTER TABLE "identity"."one_time_links" DROP CONSTRAINT "one_time_links_purpose_check";
ALTER TABLE "identity"."one_time_links"
  ADD CONSTRAINT "one_time_links_purpose_check" CHECK ("purpose" IN (
    'verify-email', 'reset-password', 'enrol-second-factor', 'confirm-second-factor-reset',
    'confirm-email-change'));
