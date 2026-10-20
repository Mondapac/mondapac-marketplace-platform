-- Reverses 20261020020000_identity_customer_storefront_appearance.
SET lock_timeout = '5s';
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_storefront_appearance_customer_check";
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_storefront_text_size_check";
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_storefront_palette_check";
ALTER TABLE "identity"."accounts" DROP COLUMN "storefront_text_size";
ALTER TABLE "identity"."accounts" DROP COLUMN "storefront_palette";
