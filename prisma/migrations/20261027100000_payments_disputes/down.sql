-- Reverses 20261027100000_payments_disputes: the dispute events leave the inbox first so the
-- narrower CHECKs hold, then the grants, the trigger and the tables. The schema stays (payments
-- holds other tables). The DELETE drops the stored dispute events, so their deduplication history is
-- lost: Stripe's later deliveries of those events would be stored again (only after a re-apply).
-- Dropping payments.outbox also drops any dispute event the relay has not published yet.
SET lock_timeout = '5s';
SET statement_timeout = '60s';
DELETE FROM "payments"."stripe_events" WHERE "type" LIKE 'charge.dispute.%';
ALTER TABLE "payments"."stripe_events"
  DROP CONSTRAINT "stripe_events_object_id_check",
  DROP CONSTRAINT "stripe_events_type_check",
  DROP CONSTRAINT "stripe_events_outcome_check",
  ADD CONSTRAINT "stripe_events_object_id_check" CHECK ("object_id" ~ '^(cs|acct)_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "stripe_events_type_check" CHECK ("type" IN (
    'checkout.session.completed', 'checkout.session.expired',
    'checkout.session.async_payment_failed', 'account.updated', 'capability.updated',
    'account.external_account.created', 'account.external_account.updated',
    'account.external_account.deleted')),
  ADD CONSTRAINT "stripe_events_outcome_check" CHECK (
    ("processed_at" IS NULL AND "outcome" IS NULL)
    OR ("processed_at" IS NOT NULL AND "outcome" IN ('confirmed', 'already-confirmed', 'voided',
      'cancelled', 'ignored', 'rejected', 'failed', 'account-updated')));

REVOKE SELECT, INSERT, UPDATE ("status", "reason", "evidence_due_by", "funds_withdrawn", "funds_withdrawn_at", "funds_reinstated", "funds_reinstated_at", "outcome", "updated_at", "last_read_at", "version") ON TABLE "payments"."disputes" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "payments"."outbox" FROM "mondapac_app";

DROP TRIGGER "disputes_guard_update" ON "payments"."disputes";
DROP FUNCTION "payments"."disputes_guard_update"();

DROP TABLE "payments"."outbox";
DROP TABLE "payments"."disputes";
