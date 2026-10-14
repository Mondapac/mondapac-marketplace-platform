-- Reverses 20261015090000_payments_payout_account_safety: the new events leave the inbox first so
-- the narrower CHECK holds, then the grants, the history table and the columns go.
DELETE FROM "payments"."stripe_events" WHERE "type" LIKE 'account.external_account.%';
ALTER TABLE "payments"."stripe_events"
  DROP CONSTRAINT "stripe_events_type_check",
  ADD CONSTRAINT "stripe_events_type_check" CHECK ("type" IN (
    'checkout.session.completed', 'checkout.session.expired',
    'checkout.session.async_payment_failed', 'account.updated', 'capability.updated'));

REVOKE SELECT, INSERT ON TABLE "payments"."payout_account_changes" FROM "mondapac_app";
REVOKE UPDATE ("cooling_off_until", "payouts_paused_until", "payout_schedule_applied", "payout_schedule_revision", "last_change_id") ON TABLE "payments"."connected_accounts" FROM "mondapac_app";
DROP TABLE "payments"."payout_account_changes";

ALTER TABLE "payments"."connected_accounts"
  DROP CONSTRAINT "connected_accounts_payout_schedule_applied_check",
  DROP CONSTRAINT "connected_accounts_payout_schedule_revision_check",
  DROP COLUMN "cooling_off_until",
  DROP COLUMN "payouts_paused_until",
  DROP COLUMN "payout_schedule_applied",
  DROP COLUMN "payout_schedule_revision",
  DROP COLUMN "last_change_id";
