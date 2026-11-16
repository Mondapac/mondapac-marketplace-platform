-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- An admin changes a customer's sign-in email (customers admin email change; design note of
-- 16 Nov 2026 with Mohammad's and Hassan's reviews). The new address waits on the account as the
-- pending address until the customer confirms it from that mailbox with the account's password;
-- the account keeps signing in with the current one until then. Three nullable columns, set and
-- cleared together (accounts_pending_email_check), for customer accounts only. The pending address
-- is not unique: two accounts may wait for the same one, and the unique index on
-- (market_id, population, email_normalized) decides at the confirmation (the clash rolls the
-- confirmation back). Nullable columns without a default: a metadata-only change; every existing
-- row passes the CHECKs (the columns are new). They validate under the ALTER's lock, as
-- 20261021180000_identity_customer_storefront_appearance. accounts already has the table UPDATE
-- grant for mondapac_app (20261007222007_identity_accounts): no grant change on accounts. The
-- lapse index is 20261116200001 (CONCURRENTLY, in a file of its own).
ALTER TABLE "identity"."accounts" ADD COLUMN "pending_email" TEXT;
ALTER TABLE "identity"."accounts" ADD COLUMN "pending_email_normalized" TEXT;
ALTER TABLE "identity"."accounts" ADD COLUMN "pending_email_requested_at" TIMESTAMPTZ(6);

ALTER TABLE "identity"."accounts"
  ADD CONSTRAINT "accounts_pending_email_check" CHECK (
    ("pending_email" IS NULL) = ("pending_email_normalized" IS NULL)
    AND ("pending_email" IS NULL) = ("pending_email_requested_at" IS NULL)),
  ADD CONSTRAINT "accounts_pending_email_customer_check"
    CHECK ("pending_email" IS NULL OR "population" = 'customer'),
  -- The same rules as accounts_email_check and accounts_email_normalized_check.
  ADD CONSTRAINT "accounts_pending_email_length_check"
    CHECK ("pending_email" IS NULL OR char_length("pending_email") BETWEEN 3 AND 254),
  ADD CONSTRAINT "accounts_pending_email_normalized_check" CHECK (
    "pending_email_normalized" IS NULL OR (
      "pending_email_normalized" = lower("pending_email_normalized" COLLATE "C")
      AND "pending_email_normalized" = btrim("pending_email_normalized")
      AND "pending_email_normalized" IS NFC NORMALIZED));

-- The new link purpose: the confirmation of a changed sign-in email, mailed to the pending address.
ALTER TABLE "identity"."one_time_links" DROP CONSTRAINT "one_time_links_purpose_check";
ALTER TABLE "identity"."one_time_links"
  ADD CONSTRAINT "one_time_links_purpose_check" CHECK ("purpose" IN (
    'verify-email', 'reset-password', 'enrol-second-factor', 'confirm-second-factor-reset',
    'confirm-email-change'));

-- One "your sign-in email was changed" notice per confirmed change (Hassan M1): written in the
-- confirmation's unit, keyed by the account version the change produced (the event's
-- aggregate_version), read and deleted by the notice handler for that event only. Both addresses
-- are sealed under the account's subject key (Hassan R11): erasure destroys the key, so a row
-- left behind is unreadable, and the row goes with its account (cascade).
CREATE TABLE "identity"."email_change_notices" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "account_version" INTEGER NOT NULL,
    "previous_email" TEXT NOT NULL,
    "new_email" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_change_notices_pkey" PRIMARY KEY ("market_id","account_id","account_version")
);

ALTER TABLE "identity"."email_change_notices" ADD CONSTRAINT "email_change_notices_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written: scope and value checks; the sealed columns use the house envelope pattern.
ALTER TABLE "identity"."email_change_notices"
  ADD CONSTRAINT "email_change_notices_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "email_change_notices_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "email_change_notices_account_version_check" CHECK ("account_version" > 1),
  ADD CONSTRAINT "email_change_notices_previous_email_check" CHECK (
    "previous_email" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("previous_email") BETWEEN 41 AND 2048),
  ADD CONSTRAINT "email_change_notices_new_email_check" CHECK (
    "new_email" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("new_email") BETWEEN 41 AND 2048);

-- Grants (database-designer): written once by the confirmation, deleted once by the notice
-- handler (compare-and-delete on the full key); never updated.
GRANT SELECT, INSERT, DELETE ON TABLE "identity"."email_change_notices" TO "mondapac_app";
