-- Reverses 20261021230000_platform_rate_limit_public_media_class: the public-media counters go
-- first, so the narrower CHECK holds again.
DELETE FROM "platform"."rate_limit_counters" WHERE "key" LIKE 'public-media:%';
ALTER TABLE "platform"."rate_limit_counters"
  DROP CONSTRAINT "rate_limit_counters_key_check",
  ADD CONSTRAINT "rate_limit_counters_key_check"
    CHECK ("key" ~ '^(anonymous-identity|default|assistant-message):[0-9a-f]{64}$');
