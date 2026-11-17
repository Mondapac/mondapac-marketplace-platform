-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- An admin's actions on a customer's personal data have their own per-subject classes, keyed by
-- the admin's account (security review of #969, L2/L3; one-hour windows):
-- admin-customer-password-reset ("send password reset") and admin-customer-pii-reveal (the
-- reveal of a sign-in's address and of a delivery address). The key CHECK lists the classes.
ALTER TABLE "platform"."rate_limit_counters"
  DROP CONSTRAINT "rate_limit_counters_key_check",
  ADD CONSTRAINT "rate_limit_counters_key_check"
    CHECK ("key" ~ '^(anonymous-identity|public-media|public-search|default|assistant-message|checkout-payment|admin-customer-password-reset|admin-customer-pii-reveal):[0-9a-f]{64}$');
