-- Payments: keep Stripe's `balance_settings.updated` (Connect endpoint). It names the connected
-- account whose payout settings changed; the worker reads the account again (F-3 record (b)).
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "payments"."stripe_events"
  DROP CONSTRAINT "stripe_events_type_check",
  ADD CONSTRAINT "stripe_events_type_check" CHECK ("type" IN (
    'checkout.session.completed', 'checkout.session.expired',
    'checkout.session.async_payment_failed', 'account.updated', 'capability.updated',
    'balance_settings.updated',
    'account.external_account.created', 'account.external_account.updated',
    'account.external_account.deleted', 'charge.dispute.created', 'charge.dispute.updated',
    'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'charge.dispute.closed',
    'transfer.created', 'transfer.reversed'));
