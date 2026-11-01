-- Reverses 20261101210100_payments_card_payment_events. A PaymentIntent event that is not processed
-- yet is a card payment still waiting to be confirmed or voided, so it is never deleted: the
-- reversal stops until the worker has processed them. Processed ones leave the inbox so the
-- narrower CHECKs hold (their deduplication history is lost).
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "payments"."stripe_events"
    WHERE "type" LIKE 'payment_intent.%' AND "processed_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'payments.stripe_events holds PaymentIntent events that are not processed; let the worker process them before reversing this migration';
  END IF;
END $$;

DELETE FROM "payments"."stripe_events" WHERE "type" LIKE 'payment_intent.%';

ALTER TABLE "payments"."stripe_events"
  DROP CONSTRAINT "stripe_events_pi_object_check",
  DROP CONSTRAINT "stripe_events_object_id_check",
  DROP CONSTRAINT "stripe_events_type_check",
  ADD CONSTRAINT "stripe_events_object_id_check" CHECK ("object_id" ~ '^(cs|acct|dp|du|tr)_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "stripe_events_type_check" CHECK ("type" IN (
    'checkout.session.completed', 'checkout.session.expired',
    'checkout.session.async_payment_failed', 'account.updated', 'capability.updated',
    'balance_settings.updated',
    'account.external_account.created', 'account.external_account.updated',
    'account.external_account.deleted', 'charge.dispute.created', 'charge.dispute.updated',
    'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'charge.dispute.closed',
    'transfer.created', 'transfer.reversed'));
