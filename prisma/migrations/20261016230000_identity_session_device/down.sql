-- Reverses 20261016230000_identity_session_device.
ALTER TABLE "identity"."sessions" DROP CONSTRAINT "sessions_device_check";
ALTER TABLE "identity"."sessions" DROP COLUMN "device";
