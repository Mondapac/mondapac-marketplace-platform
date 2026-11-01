-- Reverses 20261101210100_payments_card_payment_events: the stored PaymentIntent events leave the
-- inbox first so the narrower CHECKs hold (their deduplication history is lost).
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DELETE FROM "payments"."stripe_events" WHERE "type" LIKE 'payment_intent.%';

ALTER TABLE "payments"."stripe_events"
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
