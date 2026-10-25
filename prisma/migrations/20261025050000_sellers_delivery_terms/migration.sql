-- Seller package (e): the delivery terms of a seller, six nullable columns on the store profile.
-- The seller sets the day (same day or next day), the delivery window and the daily order cut-off,
-- all as local clock times in the seller's own zone (ADR-0005), in minutes since midnight. No
-- default and no backfill: NULL means "no terms set", which is what every existing row reads. No
-- grant change (UPDATE is already granted on the table).

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "sellers"."store_profiles" ADD COLUMN     "delivery_changed_at" TIMESTAMPTZ(6),
ADD COLUMN     "delivery_changed_by_account_id" UUID,
ADD COLUMN     "delivery_day" VARCHAR(8),
ADD COLUMN     "delivery_from_minute" SMALLINT,
ADD COLUMN     "delivery_to_minute" SMALLINT,
ADD COLUMN     "order_cutoff_minute" SMALLINT;

-- Hand-written: the CHECKs, each added NOT VALID and then validated (the columns are new and NULL,
-- so the validation is immediate and holds no long lock). The four terms are set together or not at
-- all. Half-hour steps and "a same-day cut-off falls before the window closes" are the domain's
-- rules (design 18), checked again here so a bad row cannot be written by any other path.
ALTER TABLE "sellers"."store_profiles"
  ADD CONSTRAINT "store_profiles_delivery_set_check" CHECK (("delivery_day" IS NULL) = ("delivery_from_minute" IS NULL) AND ("delivery_day" IS NULL) = ("delivery_to_minute" IS NULL) AND ("delivery_day" IS NULL) = ("order_cutoff_minute" IS NULL)) NOT VALID,
  ADD CONSTRAINT "store_profiles_delivery_day_check" CHECK ("delivery_day" IN ('same-day', 'next-day')) NOT VALID,
  ADD CONSTRAINT "store_profiles_delivery_window_check" CHECK ("delivery_from_minute" >= 0 AND "delivery_to_minute" <= 1440 AND "delivery_from_minute" < "delivery_to_minute" AND "delivery_from_minute" % 30 = 0 AND "delivery_to_minute" % 30 = 0) NOT VALID,
  ADD CONSTRAINT "store_profiles_delivery_cutoff_check" CHECK ("order_cutoff_minute" >= 0 AND "order_cutoff_minute" < 1440 AND "order_cutoff_minute" % 30 = 0 AND ("delivery_day" <> 'same-day' OR "order_cutoff_minute" < "delivery_to_minute")) NOT VALID,
  ADD CONSTRAINT "store_profiles_delivery_changed_check" CHECK (("delivery_changed_at" IS NULL) = ("delivery_changed_by_account_id" IS NULL)) NOT VALID,
  ADD CONSTRAINT "store_profiles_delivery_set_changed_check" CHECK ("delivery_day" IS NULL OR "delivery_changed_at" IS NOT NULL) NOT VALID;

ALTER TABLE "sellers"."store_profiles"
  VALIDATE CONSTRAINT "store_profiles_delivery_set_check",
  VALIDATE CONSTRAINT "store_profiles_delivery_day_check",
  VALIDATE CONSTRAINT "store_profiles_delivery_window_check",
  VALIDATE CONSTRAINT "store_profiles_delivery_cutoff_check",
  VALIDATE CONSTRAINT "store_profiles_delivery_changed_check",
  VALIDATE CONSTRAINT "store_profiles_delivery_set_changed_check";
