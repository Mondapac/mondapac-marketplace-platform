-- Reverses 20261019224900_platform_rate_limit_assistant_class: the assistant's counters go
-- first, so the narrower CHECK holds again.
DELETE FROM "platform"."rate_limit_counters" WHERE "key" LIKE 'assistant-message:%';
ALTER TABLE "platform"."rate_limit_counters"
  DROP CONSTRAINT "rate_limit_counters_key_check",
  ADD CONSTRAINT "rate_limit_counters_key_check"
    CHECK ("key" ~ '^(anonymous-identity|default):[0-9a-f]{64}$');
