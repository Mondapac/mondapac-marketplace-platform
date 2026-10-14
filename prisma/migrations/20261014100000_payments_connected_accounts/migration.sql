-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "payments"."connected_accounts" (
    "market_id" VARCHAR(8) NOT NULL,
    "seller_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_ref" TEXT,
    "status" TEXT NOT NULL,
    "details_submitted" BOOLEAN NOT NULL,
    "transfers_active" BOOLEAN NOT NULL,
    "payouts_enabled" BOOLEAN NOT NULL,
    "requirements_due" INTEGER NOT NULL,
    "requirements_past_due" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "last_read_at" TIMESTAMPTZ(6),

    CONSTRAINT "connected_accounts_pkey" PRIMARY KEY ("market_id","seller_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connected_accounts_market_id_account_ref_key" ON "payments"."connected_accounts"("market_id", "account_ref");

-- Hand-written: scope and value checks.
ALTER TABLE "payments"."connected_accounts"
  ADD CONSTRAINT "connected_accounts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "connected_accounts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "connected_accounts_account_ref_check" CHECK ("account_ref" IS NULL OR "account_ref" ~ '^acct_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "connected_accounts_status_check" CHECK ("status" IN ('not-started', 'pending', 'enabled', 'restricted', 'rejected')),
  ADD CONSTRAINT "connected_accounts_requirements_due_check" CHECK ("requirements_due" >= 0),
  -- No account at Stripe yet: nothing to be ready.
  ADD CONSTRAINT "connected_accounts_unlinked_check" CHECK ("account_ref" IS NOT NULL OR "status" = 'not-started');

-- The Stripe events inbox also keeps the connected-account events (object is the account).
ALTER TABLE "payments"."stripe_events"
  DROP CONSTRAINT "stripe_events_object_id_check",
  DROP CONSTRAINT "stripe_events_type_check",
  DROP CONSTRAINT "stripe_events_outcome_check",
  ADD CONSTRAINT "stripe_events_object_id_check" CHECK ("object_id" ~ '^(cs|acct)_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "stripe_events_type_check" CHECK ("type" IN (
    'checkout.session.completed', 'checkout.session.expired',
    'checkout.session.async_payment_failed', 'account.updated', 'capability.updated')),
  ADD CONSTRAINT "stripe_events_outcome_check" CHECK (
    ("processed_at" IS NULL AND "outcome" IS NULL)
    OR ("processed_at" IS NOT NULL AND "outcome" IN ('confirmed', 'already-confirmed', 'voided',
      'cancelled', 'ignored', 'rejected', 'failed', 'account-updated')));

-- Grants. The application inserts a row once and updates the state columns; no DELETE.
GRANT SELECT, INSERT, UPDATE ("account_ref", "status", "details_submitted", "transfers_active", "payouts_enabled", "requirements_due", "requirements_past_due", "updated_at", "last_read_at") ON TABLE "payments"."connected_accounts" TO "mondapac_app";
