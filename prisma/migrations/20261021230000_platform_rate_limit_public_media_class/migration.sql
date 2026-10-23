-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The anonymous buyer photo route has its own per-origin limit class (public-media), so a page of
-- photos cannot trip the default limit. The key CHECK lists the class.
ALTER TABLE "platform"."rate_limit_counters"
  DROP CONSTRAINT "rate_limit_counters_key_check",
  ADD CONSTRAINT "rate_limit_counters_key_check"
    CHECK ("key" ~ '^(anonymous-identity|public-media|default|assistant-message):[0-9a-f]{64}$');
