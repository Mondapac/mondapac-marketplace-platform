-- Reverses 20261111170000_platform_rate_limit_public_search_class: the public-search counters go
-- first, so the narrower CHECK holds again.
DELETE FROM "platform"."rate_limit_counters" WHERE "key" LIKE 'public-search:%';
ALTER TABLE "platform"."rate_limit_counters"
  DROP CONSTRAINT "rate_limit_counters_key_check",
  ADD CONSTRAINT "rate_limit_counters_key_check"
    CHECK ("key" ~ '^(anonymous-identity|public-media|default|assistant-message|checkout-payment):[0-9a-f]{64}$');
