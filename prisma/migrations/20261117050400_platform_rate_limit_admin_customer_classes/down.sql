-- Reverses 20261117050400_platform_rate_limit_admin_customer_classes: the counters of the two
-- admin classes go first, so the narrower CHECK holds again.
DELETE FROM "platform"."rate_limit_counters"
  WHERE "key" LIKE 'admin-customer-password-reset:%' OR "key" LIKE 'admin-customer-pii-reveal:%';
ALTER TABLE "platform"."rate_limit_counters"
  DROP CONSTRAINT "rate_limit_counters_key_check",
  ADD CONSTRAINT "rate_limit_counters_key_check"
    CHECK ("key" ~ '^(anonymous-identity|public-media|public-search|default|assistant-message|checkout-payment):[0-9a-f]{64}$');
