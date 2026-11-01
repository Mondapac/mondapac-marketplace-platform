-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The card payment attempts of a customer account have their own per-subject class
-- (checkout-payment, 10-minute window). The key CHECK lists the class.
ALTER TABLE "platform"."rate_limit_counters"
  DROP CONSTRAINT "rate_limit_counters_key_check",
  ADD CONSTRAINT "rate_limit_counters_key_check"
    CHECK ("key" ~ '^(anonymous-identity|public-media|default|assistant-message|checkout-payment):[0-9a-f]{64}$');
