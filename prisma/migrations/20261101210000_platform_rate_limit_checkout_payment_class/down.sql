-- Reverses 20261101210000_platform_rate_limit_checkout_payment_class: the checkout-payment
-- counters go first, so the narrower CHECK holds again.
DELETE FROM "platform"."rate_limit_counters" WHERE "key" LIKE 'checkout-payment:%';
ALTER TABLE "platform"."rate_limit_counters"
  DROP CONSTRAINT "rate_limit_counters_key_check",
  ADD CONSTRAINT "rate_limit_counters_key_check"
    CHECK ("key" ~ '^(anonymous-identity|public-media|default|assistant-message):[0-9a-f]{64}$');
