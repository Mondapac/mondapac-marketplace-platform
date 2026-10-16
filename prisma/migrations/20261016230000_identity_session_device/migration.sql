-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Profile package 4 (active sessions): the coarse device a session was opened on, so the holder
-- can tell their sessions apart. `<browser>.<system>`, both lower-case codes from fixed lists
-- in identity's domain; never the raw User-Agent. Nullable, no default: a metadata-only change,
-- and every session opened before it reads as an unknown device.
ALTER TABLE "identity"."sessions" ADD COLUMN "device" VARCHAR(32);

ALTER TABLE "identity"."sessions"
  ADD CONSTRAINT "sessions_device_check" CHECK ("device" IS NULL OR "device" ~ '^[a-z]+\.[a-z]+$');
