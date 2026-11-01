-- Payments: keep Stripe's PaymentIntent events of the card payment made on the MondaPac page
-- (checkout payment API). The object is a PaymentIntent (pi_...); the worker reads it again.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "payments"."stripe_events"
  DROP CONSTRAINT "stripe_events_object_id_check",
  DROP CONSTRAINT "stripe_events_type_check",
  ADD CONSTRAINT "stripe_events_object_id_check" CHECK ("object_id" ~ '^(cs|acct|dp|du|tr|pi)_[A-Za-z0-9_]{1,200}$'),
  ADD CONSTRAINT "stripe_events_type_check" CHECK ("type" IN (
    'checkout.session.completed', 'checkout.session.expired',
    'checkout.session.async_payment_failed', 'account.updated', 'capability.updated',
    'balance_settings.updated',
    'account.external_account.created', 'account.external_account.updated',
    'account.external_account.deleted', 'charge.dispute.created', 'charge.dispute.updated',
    'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'charge.dispute.closed',
    'transfer.created', 'transfer.reversed',
    'payment_intent.amount_capturable_updated', 'payment_intent.payment_failed',
    'payment_intent.canceled'));
