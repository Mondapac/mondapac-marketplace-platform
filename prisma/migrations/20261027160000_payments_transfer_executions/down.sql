-- Reverses 20261027160000_payments_transfer_executions: the transfer events leave the inbox first
-- so the narrower CHECKs hold, then the grants, the trigger and the table, then the columns. The
-- DELETE drops the stored transfer events, so their deduplication history is lost. The transfer
-- executions themselves are dropped with their table: run this only where no transfer was sent.
-- A change found by the live check keeps its row; it gets a placeholder event id so the original
-- NOT NULL and pattern CHECK hold again.
SET lock_timeout = '5s';
SET statement_timeout = '60s';
DELETE FROM "payments"."stripe_events" WHERE "type" LIKE 'transfer.%';
ALTER TABLE "payments"."stripe_events"
  DROP CONSTRAINT "stripe_events_object_id_check",
  DROP CONSTRAINT "stripe_events_type_check",
  DROP CONSTRAINT "stripe_events_outcome_check",
  ADD CONSTRAINT "stripe_events_object_id_check" CHECK ("object_id" ~ '^(cs|acct|dp|du)_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "stripe_events_type_check" CHECK ("type" IN (
    'checkout.session.completed', 'checkout.session.expired',
    'checkout.session.async_payment_failed', 'account.updated', 'capability.updated',
    'account.external_account.created', 'account.external_account.updated',
    'account.external_account.deleted', 'charge.dispute.created', 'charge.dispute.updated',
    'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'charge.dispute.closed')),
  ADD CONSTRAINT "stripe_events_outcome_check" CHECK (
    ("processed_at" IS NULL AND "outcome" IS NULL)
    OR ("processed_at" IS NOT NULL AND "outcome" IN ('confirmed', 'already-confirmed', 'voided',
      'cancelled', 'ignored', 'rejected', 'failed', 'account-updated', 'dispute-recorded',
      'other-market')));

REVOKE UPDATE ("external_account_hmac") ON TABLE "payments"."connected_accounts" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("state", "provider_transfer_ref", "failure_code", "reversed_minor", "send_count", "lease_until", "abandoned_at", "fence_breached_at", "executed_at", "updated_at", "version") ON TABLE "payments"."transfer_executions" FROM "mondapac_app";

DROP TRIGGER "transfer_executions_guard_update" ON "payments"."transfer_executions";
DROP FUNCTION "payments"."transfer_executions_guard_update"();

DROP TABLE "payments"."transfer_executions";

UPDATE "payments"."payout_account_changes"
  SET "source_event_id" = 'evt_livecheck_' || replace("id"::text, '-', '')
  WHERE "source_event_id" IS NULL;
ALTER TABLE "payments"."payout_account_changes"
  DROP CONSTRAINT "payout_account_changes_source_event_id_check",
  DROP CONSTRAINT "payout_account_changes_detected_by_check",
  ALTER COLUMN "source_event_id" SET NOT NULL,
  DROP COLUMN "detected_by",
  ADD CONSTRAINT "payout_account_changes_source_event_id_check" CHECK ("source_event_id" ~ '^evt_[A-Za-z0-9_]{1,200}$');

ALTER TABLE "payments"."connected_accounts"
  DROP CONSTRAINT "connected_accounts_external_account_hmac_check",
  DROP COLUMN "external_account_hmac";
