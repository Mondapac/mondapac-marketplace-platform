-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The buyer assistant's per-subject message counters (SUBJECT_LIMIT_WINDOWS, class
-- assistant-message) share the table of the per-origin limiter: the key CHECK lists the class.
ALTER TABLE "platform"."rate_limit_counters"
  DROP CONSTRAINT "rate_limit_counters_key_check",
  ADD CONSTRAINT "rate_limit_counters_key_check"
    CHECK ("key" ~ '^(anonymous-identity|default|assistant-message):[0-9a-f]{64}$');
