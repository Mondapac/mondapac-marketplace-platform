-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
-- The stripe_events CHECK swap re-scans the inbox under its lock: bound how long that may take.
SET statement_timeout = '60s';

-- AlterTable: the keyed hash of the default external account's Stripe id (HP-1 condition 2).
ALTER TABLE "payments"."connected_accounts" ADD COLUMN "external_account_hmac" TEXT;

-- AlterTable: a change can also be found by the live check before a transfer, which has no event.
ALTER TABLE "payments"."payout_account_changes" ADD COLUMN "detected_by" TEXT NOT NULL DEFAULT 'webhook',
ALTER COLUMN "source_event_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "payments"."transfer_executions" (
    "market_id" VARCHAR(8) NOT NULL,
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "instruction_key" TEXT NOT NULL,
    "seller_id" UUID,
    "account_ref" TEXT,
    "amount_minor" BIGINT,
    "currency" CHAR(3),
    "reference" UUID,
    "state" TEXT NOT NULL,
    "provider_transfer_ref" TEXT,
    "failure_code" TEXT,
    "reversed_minor" BIGINT NOT NULL DEFAULT 0,
    "send_count" SMALLINT NOT NULL,
    "lease_until" TIMESTAMPTZ(6),
    "abandoned_at" TIMESTAMPTZ(6),
    "fence_breached_at" TIMESTAMPTZ(6),
    "executed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "transfer_executions_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateIndex
CREATE INDEX "transfer_executions_market_id_state_lease_until_idx" ON "payments"."transfer_executions"("market_id", "state", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_executions_market_id_instruction_key_key" ON "payments"."transfer_executions"("market_id", "instruction_key");

-- Hand-written: the keyed hash carries the key version, so a key rotation is not read as a changed
-- bank account. It is a hash of an id, never the id and never bank data (VER-10).
ALTER TABLE "payments"."connected_accounts"
  ADD CONSTRAINT "connected_accounts_external_account_hmac_check"
    CHECK ("external_account_hmac" IS NULL OR "external_account_hmac" ~ '^hmac-sha256:k[1-9][0-9]{0,3}:[0-9a-f]{64}$');

-- Hand-written: a change is reported by an event, or found by the live check (which has no event).
ALTER TABLE "payments"."payout_account_changes"
  DROP CONSTRAINT "payout_account_changes_source_event_id_check",
  ADD CONSTRAINT "payout_account_changes_detected_by_check" CHECK ("detected_by" IN ('webhook', 'live-check')),
  ADD CONSTRAINT "payout_account_changes_source_event_id_check" CHECK (
    ("detected_by" = 'webhook' AND "source_event_id" IS NOT NULL AND "source_event_id" ~ '^evt_[A-Za-z0-9_]{1,200}$')
    OR ("detected_by" = 'live-check' AND "source_event_id" IS NULL));

-- Hand-written: the transfer executions. A command row has its seller, account, amount, currency
-- and reference; a tombstone (a key abandoned before any send) has none of them.
ALTER TABLE "payments"."transfer_executions"
  ADD CONSTRAINT "transfer_executions_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id")
    REFERENCES "payments"."connected_accounts"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "transfer_executions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "transfer_executions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "transfer_executions_instruction_key_check" CHECK ("instruction_key" ~ '^[A-Za-z0-9:_-]{1,128}$'),
  ADD CONSTRAINT "transfer_executions_account_ref_check" CHECK ("account_ref" IS NULL OR "account_ref" ~ '^acct_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "transfer_executions_amount_minor_check" CHECK ("amount_minor" IS NULL OR "amount_minor" > 0),
  ADD CONSTRAINT "transfer_executions_currency_check" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "transfer_executions_provider_transfer_ref_check" CHECK ("provider_transfer_ref" IS NULL OR "provider_transfer_ref" ~ '^tr_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "transfer_executions_state_check" CHECK ("state" IN ('reserved', 'sending', 'executed', 'refused', 'abandoned', 'failed')),
  ADD CONSTRAINT "transfer_executions_failure_code_check" CHECK ("failure_code" IS NULL OR "failure_code" IN ('insufficient-platform-balance', 'provider-refused', 'transfer-failed')),
  ADD CONSTRAINT "transfer_executions_send_count_check" CHECK ("send_count" BETWEEN 0 AND 1),
  ADD CONSTRAINT "transfer_executions_version_check" CHECK ("version" >= 1),
  -- A command row has all five content columns; a tombstone has none, is abandoned and was never sent.
  ADD CONSTRAINT "transfer_executions_shape_check" CHECK (
    ("seller_id" IS NOT NULL AND "account_ref" IS NOT NULL AND "amount_minor" IS NOT NULL
      AND "currency" IS NOT NULL AND "reference" IS NOT NULL)
    OR ("seller_id" IS NULL AND "account_ref" IS NULL AND "amount_minor" IS NULL
      AND "currency" IS NULL AND "reference" IS NULL AND "state" = 'abandoned' AND "send_count" = 0
      AND "provider_transfer_ref" IS NULL AND "fence_breached_at" IS NULL AND "executed_at" IS NULL)),
  -- Each state carries what it needs and nothing that belongs to another.
  ADD CONSTRAINT "transfer_executions_state_columns_check" CHECK (
    CASE "state"
      WHEN 'reserved' THEN "send_count" = 0
      WHEN 'sending' THEN "send_count" = 1 AND "lease_until" IS NOT NULL AND "provider_transfer_ref" IS NULL
      WHEN 'executed' THEN "send_count" = 1 AND "provider_transfer_ref" IS NOT NULL AND "executed_at" IS NOT NULL
      WHEN 'refused' THEN "failure_code" IS NOT NULL AND "provider_transfer_ref" IS NULL
      WHEN 'abandoned' THEN "abandoned_at" IS NOT NULL AND "provider_transfer_ref" IS NULL
      WHEN 'failed' THEN "send_count" = 1 AND "provider_transfer_ref" IS NOT NULL
    END),
  ADD CONSTRAINT "transfer_executions_failure_state_check" CHECK ("failure_code" IS NULL OR "state" IN ('refused', 'failed')),
  -- What was reversed is part of what was sent, and only an executed transfer can be reversed.
  ADD CONSTRAINT "transfer_executions_reversed_check" CHECK (
    "reversed_minor" >= 0 AND ("amount_minor" IS NULL OR "reversed_minor" <= "amount_minor")
    AND ("reversed_minor" = 0 OR "state" = 'executed')),
  -- A breach is a transfer found for a row that was abandoned: it was sent once.
  ADD CONSTRAINT "transfer_executions_fence_breach_check" CHECK (
    "fence_breached_at" IS NULL
    OR ("seller_id" IS NOT NULL AND "send_count" = 1 AND "state" IN ('executed', 'failed')));

-- Hand-written: what is sent is sent once and what Stripe created is never taken back. The
-- content never changes; a send is counted once; the Stripe id and the instants are written once;
-- the states only move along the machine (a failed or refused transfer is final; an abandoned one
-- moves only to executed, and only as a recorded fence breach of a row that was sent); the
-- reversed amount only grows; each change raises the version by one, whoever asks.
CREATE FUNCTION "payments"."transfer_executions_guard_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."market_id" IS DISTINCT FROM OLD."market_id" OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."instruction_key" IS DISTINCT FROM OLD."instruction_key"
     OR NEW."seller_id" IS DISTINCT FROM OLD."seller_id"
     OR NEW."account_ref" IS DISTINCT FROM OLD."account_ref"
     OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'payments.transfer_executions: what a transfer is about never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."state" IN ('refused', 'failed') THEN
    RAISE EXCEPTION 'payments.transfer_executions: a refused or failed transfer is final'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."send_count" IS DISTINCT FROM OLD."send_count"
     AND NOT (OLD."send_count" = 0 AND NEW."send_count" = 1) THEN
    RAISE EXCEPTION 'payments.transfer_executions: a transfer is sent at most once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."provider_transfer_ref" IS NOT NULL AND NEW."provider_transfer_ref" IS DISTINCT FROM OLD."provider_transfer_ref")
     OR (OLD."executed_at" IS NOT NULL AND NEW."executed_at" IS DISTINCT FROM OLD."executed_at")
     OR (OLD."abandoned_at" IS NOT NULL AND NEW."abandoned_at" IS DISTINCT FROM OLD."abandoned_at")
     OR (OLD."fence_breached_at" IS NOT NULL AND NEW."fence_breached_at" IS DISTINCT FROM OLD."fence_breached_at") THEN
    RAISE EXCEPTION 'payments.transfer_executions: a recorded id or instant is written once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."reversed_minor" < OLD."reversed_minor" THEN
    RAISE EXCEPTION 'payments.transfer_executions: a reversal cannot be taken back'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
       (OLD."state" = 'reserved' AND NEW."state" IN ('sending', 'abandoned', 'refused'))
    OR (OLD."state" = 'sending' AND NEW."state" IN ('executed', 'refused', 'abandoned'))
    OR (OLD."state" = 'executed' AND NEW."state" = 'failed')
    OR (OLD."state" = 'abandoned' AND NEW."state" = 'executed' AND OLD."send_count" = 1
        AND OLD."fence_breached_at" IS NULL AND NEW."fence_breached_at" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'payments.transfer_executions: this state change is not allowed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."fence_breached_at" IS DISTINCT FROM OLD."fence_breached_at"
     AND NOT (OLD."state" = 'abandoned' AND NEW."state" = 'executed') THEN
    RAISE EXCEPTION 'payments.transfer_executions: a fence breach is only recorded on an abandoned transfer'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'payments.transfer_executions: each change raises the version by one'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "transfer_executions_guard_update" BEFORE UPDATE ON "payments"."transfer_executions"
  FOR EACH ROW EXECUTE FUNCTION "payments"."transfer_executions_guard_update"();

-- The Stripe events inbox also keeps the transfer events (object is the transfer) and their outcome.
ALTER TABLE "payments"."stripe_events"
  DROP CONSTRAINT "stripe_events_object_id_check",
  DROP CONSTRAINT "stripe_events_type_check",
  DROP CONSTRAINT "stripe_events_outcome_check",
  ADD CONSTRAINT "stripe_events_object_id_check" CHECK ("object_id" ~ '^(cs|acct|dp|du|tr)_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "stripe_events_type_check" CHECK ("type" IN (
    'checkout.session.completed', 'checkout.session.expired',
    'checkout.session.async_payment_failed', 'account.updated', 'capability.updated',
    'account.external_account.created', 'account.external_account.updated',
    'account.external_account.deleted', 'charge.dispute.created', 'charge.dispute.updated',
    'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'charge.dispute.closed',
    'transfer.created', 'transfer.reversed')),
  ADD CONSTRAINT "stripe_events_outcome_check" CHECK (
    ("processed_at" IS NULL AND "outcome" IS NULL)
    OR ("processed_at" IS NOT NULL AND "outcome" IN ('confirmed', 'already-confirmed', 'voided',
      'cancelled', 'ignored', 'rejected', 'failed', 'account-updated', 'dispute-recorded',
      'other-market', 'transfer-recorded')));

-- Grants. A transfer is inserted once; only its changing state is updated (never the key, seller,
-- account, amount, currency or reference). No row is deleted by the application. The account row
-- gains the hash column the re-read moves.
GRANT SELECT, INSERT, UPDATE ("state", "provider_transfer_ref", "failure_code", "reversed_minor", "send_count", "lease_until", "abandoned_at", "fence_breached_at", "executed_at", "updated_at", "version") ON TABLE "payments"."transfer_executions" TO "mondapac_app";
GRANT UPDATE ("external_account_hmac") ON TABLE "payments"."connected_accounts" TO "mondapac_app";
