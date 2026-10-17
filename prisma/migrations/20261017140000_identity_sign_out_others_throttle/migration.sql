-- Profile package 4, Hassan's follow-up: the `sign-out-others.account` counter limits how often
-- an account signs out its other sessions. A new throttle kind is a migration (data design 3.5);
-- it carries an `account_key`, like every address kind.
SET lock_timeout = '5s';

ALTER TABLE "identity"."sign_in_throttles"
  DROP CONSTRAINT "sign_in_throttles_kind_check",
  ADD CONSTRAINT "sign_in_throttles_kind_check" CHECK ("kind" IN (
    'sign-in.account-origin', 'sign-in.account', 'sign-in.origin',
    'second-factor.account', 'mail.account', 'mail.origin', 'sign-out-others.account'));
