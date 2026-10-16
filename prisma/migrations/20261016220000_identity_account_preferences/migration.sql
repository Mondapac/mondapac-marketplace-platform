-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Panel display preferences of an account: the holder's own IANA time zone and panel language.
-- NULL means "no choice" (the panel keeps its own rule). Two nullable columns, no default: a
-- metadata-only change.
ALTER TABLE "identity"."accounts" ADD COLUMN "timezone" VARCHAR(64);
ALTER TABLE "identity"."accounts" ADD COLUMN "locale" VARCHAR(16);

ALTER TABLE "identity"."accounts"
  ADD CONSTRAINT "accounts_timezone_check" CHECK ("timezone" IS NULL OR char_length("timezone") BETWEEN 1 AND 64),
  ADD CONSTRAINT "accounts_locale_check" CHECK ("locale" IS NULL OR char_length("locale") BETWEEN 2 AND 16);
