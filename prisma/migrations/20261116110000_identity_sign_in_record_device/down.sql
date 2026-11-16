-- Reverses 20261116110000_identity_sign_in_record_device.
SET lock_timeout = '5s';

ALTER TABLE "identity"."sign_in_records" DROP CONSTRAINT "sign_in_records_device_check";
ALTER TABLE "identity"."sign_in_records" DROP COLUMN "device";
