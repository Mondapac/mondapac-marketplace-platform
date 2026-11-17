-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Customers management phase 2b (the customer page's logins list): the coarse device of each
-- sign-in attempt, `<browser>.<system>` from the fixed lists in identity's domain, as a session
-- keeps it; never the raw User-Agent. Nullable, no default: a metadata-only change, and every
-- record written before it reads as an unknown device (records are kept 90 days).
ALTER TABLE "identity"."sign_in_records" ADD COLUMN "device" VARCHAR(32);

-- NOT VALID, then VALIDATE (data design 9.3): added without a long lock; every existing row is NULL.
ALTER TABLE "identity"."sign_in_records"
  ADD CONSTRAINT "sign_in_records_device_check" CHECK ("device" IS NULL OR "device" ~ '^[a-z]+\.[a-z]+$') NOT VALID;
ALTER TABLE "identity"."sign_in_records" VALIDATE CONSTRAINT "sign_in_records_device_check";
