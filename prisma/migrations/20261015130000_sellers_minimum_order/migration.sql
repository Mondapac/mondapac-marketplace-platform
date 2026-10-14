-- Sellers slice 20 (sellers design 18; data design 3.8, row 16): the optional minimum order of a
-- seller, four nullable columns on the store profile. No default and no backfill: NULL means "no
-- minimum", which is what every existing row reads. No grant change (UPDATE is already granted).

-- AlterTable
ALTER TABLE "sellers"."store_profiles" ADD COLUMN     "minimum_order_amount" BIGINT,
ADD COLUMN     "minimum_order_changed_at" TIMESTAMPTZ(6),
ADD COLUMN     "minimum_order_changed_by_account_id" UUID,
ADD COLUMN     "minimum_order_currency" CHAR(3);

-- Hand-written: the five CHECKs, each added NOT VALID and then validated (the columns are new and
-- NULL, so the validation is immediate and holds no long lock). Equality with the Market currency
-- and the upper bound are the use case's (design 18 decision 3), never a CHECK.
ALTER TABLE "sellers"."store_profiles"
  ADD CONSTRAINT "store_profiles_minimum_order_pair_check" CHECK (("minimum_order_amount" IS NULL) = ("minimum_order_currency" IS NULL)) NOT VALID,
  ADD CONSTRAINT "store_profiles_minimum_order_amount_check" CHECK ("minimum_order_amount" > 0) NOT VALID,
  ADD CONSTRAINT "store_profiles_minimum_order_currency_check" CHECK ("minimum_order_currency" ~ '^[A-Z]{3}$') NOT VALID,
  ADD CONSTRAINT "store_profiles_minimum_order_changed_check" CHECK (("minimum_order_changed_at" IS NULL) = ("minimum_order_changed_by_account_id" IS NULL)) NOT VALID,
  ADD CONSTRAINT "store_profiles_minimum_order_set_changed_check" CHECK ("minimum_order_amount" IS NULL OR "minimum_order_changed_at" IS NOT NULL) NOT VALID;

ALTER TABLE "sellers"."store_profiles"
  VALIDATE CONSTRAINT "store_profiles_minimum_order_pair_check",
  VALIDATE CONSTRAINT "store_profiles_minimum_order_amount_check",
  VALIDATE CONSTRAINT "store_profiles_minimum_order_currency_check",
  VALIDATE CONSTRAINT "store_profiles_minimum_order_changed_check",
  VALIDATE CONSTRAINT "store_profiles_minimum_order_set_changed_check";
