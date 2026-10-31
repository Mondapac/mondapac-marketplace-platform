-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Wallet switch version (settings S4, PR-4): the save compares it, so a stale admin tab gets 409
-- wallet.settings-conflict. No row (or the seeded "never set" row) reads as version 0; the first
-- real save writes 1. The value is set by the use case under the row lock.

-- AlterTable
ALTER TABLE "wallet"."market_settings" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Hand-written: a version starts at 1.
ALTER TABLE "wallet"."market_settings"
  ADD CONSTRAINT "market_settings_version_check" CHECK ("version" >= 1);

-- Grants (database-designer): docs/design/data/platform.md section 10. The column-level UPDATE
-- grant of 20261025130000_wallet_ledger_core gains "version".
GRANT UPDATE ("version") ON TABLE "wallet"."market_settings" TO "mondapac_app";
