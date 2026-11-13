-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The storefront text search (search/products, search/stores) has its own per-origin limit class
-- (public-search; Hassan L-3 on search 1a), so its limit is tuned apart from the default. The key
-- CHECK lists the class.
ALTER TABLE "platform"."rate_limit_counters"
  DROP CONSTRAINT "rate_limit_counters_key_check",
  ADD CONSTRAINT "rate_limit_counters_key_check"
    CHECK ("key" ~ '^(anonymous-identity|public-media|public-search|default|assistant-message|checkout-payment):[0-9a-f]{64}$');
