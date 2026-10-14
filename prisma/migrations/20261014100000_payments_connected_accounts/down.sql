-- Reverses 20261014100000_payments_connected_accounts: connected-account events are removed from
-- the inbox first so the narrower CHECKs hold, then the table and its grants go.
DELETE FROM "payments"."stripe_events" WHERE "type" IN ('account.updated', 'capability.updated');
ALTER TABLE "payments"."stripe_events"
  DROP CONSTRAINT "stripe_events_object_id_check",
  DROP CONSTRAINT "stripe_events_type_check",
  DROP CONSTRAINT "stripe_events_outcome_check",
  ADD CONSTRAINT "stripe_events_object_id_check" CHECK ("object_id" ~ '^cs_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "stripe_events_type_check" CHECK ("type" IN (
    'checkout.session.completed', 'checkout.session.expired',
    'checkout.session.async_payment_failed')),
  ADD CONSTRAINT "stripe_events_outcome_check" CHECK (
    ("processed_at" IS NULL AND "outcome" IS NULL)
    OR ("processed_at" IS NOT NULL AND "outcome" IN ('confirmed', 'already-confirmed', 'voided',
      'cancelled', 'ignored', 'rejected', 'failed')));

REVOKE SELECT, INSERT, UPDATE ("account_ref", "status", "details_submitted", "transfers_active", "payouts_enabled", "requirements_due", "requirements_past_due", "updated_at", "last_read_at") ON TABLE "payments"."connected_accounts" FROM "mondapac_app";
DROP TABLE "payments"."connected_accounts";
