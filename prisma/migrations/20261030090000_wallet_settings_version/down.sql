-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261030090000_wallet_settings_version: the switch loses its version.
REVOKE UPDATE ("version") ON TABLE "wallet"."market_settings" FROM "mondapac_app";
ALTER TABLE "wallet"."market_settings" DROP CONSTRAINT "market_settings_version_check";
ALTER TABLE "wallet"."market_settings" DROP COLUMN "version";
