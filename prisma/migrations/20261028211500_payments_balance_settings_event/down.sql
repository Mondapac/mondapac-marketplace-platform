-- Reverses 20261028211500_payments_balance_settings_event: the stored balance-settings events
-- leave the inbox first so the narrower CHECK holds (their deduplication history is lost).
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DELETE FROM "payments"."stripe_events" WHERE "type" = 'balance_settings.updated';

ALTER TABLE "payments"."stripe_events"
  DROP CONSTRAINT "stripe_events_type_check",
  ADD CONSTRAINT "stripe_events_type_check" CHECK ("type" IN (
    'checkout.session.completed', 'checkout.session.expired',
    'checkout.session.async_payment_failed', 'account.updated', 'capability.updated',
    'account.external_account.created', 'account.external_account.updated',
    'account.external_account.deleted', 'charge.dispute.created', 'charge.dispute.updated',
    'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'charge.dispute.closed',
    'transfer.created', 'transfer.reversed'));
