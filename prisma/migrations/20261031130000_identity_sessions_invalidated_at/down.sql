-- Reverses 20261031130000_identity_sessions_invalidated_at.
SET lock_timeout = '5s';
ALTER TABLE "identity"."accounts" DROP COLUMN "sessions_invalidated_at";
