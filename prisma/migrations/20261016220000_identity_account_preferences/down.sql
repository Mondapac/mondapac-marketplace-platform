-- Reverses 20261016220000_identity_account_preferences.
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_locale_check";
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_timezone_check";
ALTER TABLE "identity"."accounts" DROP COLUMN "locale";
ALTER TABLE "identity"."accounts" DROP COLUMN "timezone";
