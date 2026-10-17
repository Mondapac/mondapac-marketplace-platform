-- Reverses 20261017140000_identity_sign_out_others_throttle: its counters go first, so the
-- narrower CHECK can be added back.
SET lock_timeout = '5s';

DELETE FROM "identity"."sign_in_throttles" WHERE "kind" = 'sign-out-others.account';

ALTER TABLE "identity"."sign_in_throttles"
  DROP CONSTRAINT "sign_in_throttles_kind_check",
  ADD CONSTRAINT "sign_in_throttles_kind_check" CHECK ("kind" IN (
    'sign-in.account-origin', 'sign-in.account', 'sign-in.origin',
    'second-factor.account', 'mail.account', 'mail.origin'));
